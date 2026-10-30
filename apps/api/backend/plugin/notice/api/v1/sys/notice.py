from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from pyrate_limiter import Duration, Rate

from backend.app.admin.schema.export_job import GetExportJobDetail, StartExportParam
from backend.app.admin.service.export_service import export_service
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.notice.dataio import NOTICE_EXPORT
from backend.plugin.notice.schema.notice import (
    CreateNoticeParam,
    DeleteNoticeParam,
    GetNoticeDetail,
    GetNoticeFeedDetail,
    GetNoticeFeedItem,
    GetNoticePublicItem,
    GetNoticeReadsPage,
    UpdateNoticeParam,
)
from backend.plugin.notice.service.notice_service import notice_service
from backend.plugin.notification.audience import viewer_of
from backend.utils.limiter import RateLimiter

router = APIRouter()


@router.post(
    '/export',
    summary='导出通知公告',
    dependencies=[Depends(RequestPermission('sys:notice:export')), DependsRBAC],
)
async def export_notices(
    request: Request, db: CurrentSession, obj: StartExportParam
) -> ResponseSchemaModel[GetExportJobDetail]:
    # 小批量当场生成完才返回（status=2，前端直接下载）；大批量返回排队（status=0），生成完发站内消息
    data = await export_service.start(db=db, request=request, spec=NOTICE_EXPORT, obj=obj)
    return response_base.success(data=data)


# ─── 读者那一侧（#186）：只要登录。⚠️ 要声明在 `/{pk}` 前面，不然 `feed` 会被当成 pk ──────────────
#
# 「谁看得见」按看的人算（#190）：显示中 · 到了发布时间 · 没过期 · 发布范围里有他（`readable_clause(viewer)`）


@router.get('/feed', summary='分页获取我能看的公告', dependencies=[DependsJwtAuth, DependsPagination])
async def get_notice_feed(request: Request, db: CurrentSession) -> ResponseSchemaModel[PageData[GetNoticeFeedItem]]:
    # 置顶在前；带附件数和「我读没读」，不带正文（只选列表要的列）。工作台 / 移动端首页用它
    page_data = await notice_service.get_feed(db=db, viewer=await viewer_of(db, request.user))
    return response_base.success(data=page_data)


# ⚠️ `/feed/popups`、`/feed/banner` 要声明在 `/feed/{pk}` 前面，不然 `popups` 被当成 pk、422


@router.get('/feed/popups', summary='获取登录后要弹给我的公告', dependencies=[DependsJwtAuth])
async def get_notice_popups(request: Request, db: CurrentSession) -> ResponseSchemaModel[list[GetNoticeFeedDetail]]:
    # 看得见 · 弹窗 · 我没读（必须确认的只认点过「我已阅读」）；置顶 → 级别 → 新到旧，最多 10 条，带正文。
    # 看完 / 点「我已阅读」走 `PUT /sys/notifications/{notification_id}/read`
    data = await notice_service.get_popups(db=db, viewer=await viewer_of(db, request.user))
    return response_base.success(data=data)


@router.get('/feed/banner', summary='获取我的公告横幅', dependencies=[DependsJwtAuth])
async def get_notice_banner(request: Request, db: CurrentSession) -> ResponseSchemaModel[list[GetNoticeFeedItem]]:
    # 看得见 · 置顶 · 紧急 · 我没读；最多 3 条，不带正文。关掉横幅 = 标已读（同上那个接口）
    data = await notice_service.get_banner(db=db, viewer=await viewer_of(db, request.user))
    return response_base.success(data=data)


@router.get('/feed/{pk}', summary='获取我能看的公告详情', dependencies=[DependsJwtAuth])
async def get_notice_feed_detail(
    request: Request, db: CurrentSession, pk: Annotated[int, Path(description='通知公告 ID')]
) -> ResponseSchemaModel[GetNoticeFeedDetail]:
    data = await notice_service.get_feed_detail(db=db, viewer=await viewer_of(db, request.user), pk=pk)
    return response_base.success(data=data)


# ─── 登录页（#190）：**不用登录**。路径在 `TOKEN_REQUEST_PATH_EXCLUDE` 里（精确匹配）：浏览器里留着一个过期 token
# 也不会被 JWT 中间件先 401 掉。每个 IP 每分钟 30 次


@router.get(
    '/public',
    summary='获取登录页公告',
    dependencies=[Depends(RateLimiter(Rate(30, Duration.MINUTE)))],
)
async def get_public_notices(db: CurrentSession) -> ResponseSchemaModel[list[GetNoticePublicItem]]:
    # 发出去了 · 登录页可见 · 没有发布范围；最多 5 条。只给纯文本摘要（不带正文、附件、图）
    data = await notice_service.get_public(db=db)
    return response_base.success(data=data)


# ─── 管理端 ─────────────────────────────────────────────────────────────────────────
#
# 🔴 两条读接口原来只挂 `DependsJwtAuth`，「给所有人看公告」和「管理列表」共用一个口：
# 任何登录用户都拿得到**隐藏的**公告和正文（#186 实测）。读者现在走上面的 `/feed`，
# 这两条挂上和管理页路由守卫同一个权限码（`apps/web/src/routes/_auth/plugins/notice.tsx`）


@router.get(
    '/{pk}/reads',
    summary='获取通知公告的阅读统计',
    dependencies=[Depends(RequestPermission('sys:notice:add')), DependsRBAC, DependsPagination],
)
async def get_notice_reads(
    db: CurrentSession,
    pk: Annotated[int, Path(description='通知公告 ID')],
    *,
    read: Annotated[bool, Query(description='true：已读的；false：未读的（发布范围内、启用的账号）')] = True,
) -> ResponseSchemaModel[GetNoticeReadsPage]:
    # 分页的 total 是当前页签的条数；read_count / unread_count 两个页签的人数一起给
    data = await notice_service.get_reads(db=db, pk=pk, read=read)
    return response_base.success(data=data)


@router.get(
    '/{pk}',
    summary='获取通知公告详情',
    dependencies=[Depends(RequestPermission('sys:notice:add')), DependsRBAC],
)
async def get_notice(
    db: CurrentSession, pk: Annotated[int, Path(description='通知公告 ID')]
) -> ResponseSchemaModel[GetNoticeDetail]:
    notice = await notice_service.get(db=db, pk=pk)
    return response_base.success(data=notice)


@router.get(
    '',
    summary='分页获取所有通知公告',
    dependencies=[
        Depends(RequestPermission('sys:notice:add')),
        DependsRBAC,
        DependsPagination,
    ],
)
async def get_notices_paginated(
    db: CurrentSession,
    title: Annotated[str | None, Query(description='标题')] = None,
    type: Annotated[int | None, Query(description='类型')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[PageData[GetNoticeDetail]]:
    page_data = await notice_service.get_list(db=db, title=title, type=type, status=status)
    return response_base.success(data=page_data)


@router.post(
    '',
    summary='创建通知公告',
    dependencies=[
        Depends(RequestPermission('sys:notice:add')),
        DependsRBAC,
    ],
)
async def create_notice(
    request: Request, db: CurrentSessionTransaction, obj: CreateNoticeParam
) -> ResponseSchemaModel[GetNoticeDetail]:
    # 下发创建结果而不是空 success()：前端要用这个 id 把正文里的内联图
    # 挂到 `sys_file_relation` 上（见 pages/notice/api.ts 的 syncNoticeImages）。
    # 拿不到 id 的话，新建公告里的图就是一批没人认领的孤儿文件
    notice = await notice_service.create(db=db, user=request.user, obj=obj)
    return response_base.success(data=notice)


@router.put(
    '/{pk}',
    summary='更新通知公告',
    dependencies=[
        Depends(RequestPermission('sys:notice:edit')),
        DependsRBAC,
    ],
)
async def update_notice(
    request: Request,
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='通知公告 ID')],
    obj: UpdateNoticeParam,
) -> ResponseModel:
    count = await notice_service.update(db=db, user=request.user, pk=pk, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.delete(
    '',
    summary='批量删除通知公告',
    dependencies=[
        Depends(RequestPermission('sys:notice:del')),
        DependsRBAC,
    ],
)
async def delete_notices(db: CurrentSessionTransaction, obj: DeleteNoticeParam) -> ResponseModel:
    count = await notice_service.delete(db=db, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()
