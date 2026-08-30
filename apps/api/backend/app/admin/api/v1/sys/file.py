from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Path, Query, Request, UploadFile
from fastapi.responses import FileResponse

from backend.app.admin.schema.file import (
    CreateFileRelationParam,
    DeleteFileParam,
    DeleteFileRelationParam,
    GetFileDetail,
    GetFileStatisticsDetail,
)
from backend.app.admin.service.file_service import file_service
from backend.common.enums import FileType
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.post(
    '/upload',
    summary='上传文件',
    dependencies=[
        Depends(RequestPermission('sys:file:upload')),
        DependsRBAC,
    ],
)
async def upload_file(
    request: Request,
    db: CurrentSessionTransaction,
    file: Annotated[UploadFile, File(description='文件')],
    # 落公开子树 —— 只给富文本正文里的内联图用。
    #
    # 做成显式入参而不是「图片自动公开」：图片不都该公开（文件管理页传的
    # 身份证扫描件也是图片）。服务端只强制「公开的必须是图片」，
    # 不反过来推。⚠️ 前端别把这个参数接到文件管理页的通用上传按钮上
    *,
    public: Annotated[bool, Query(description='落公开子树，产出无鉴权直链（仅图片）')] = False,
) -> ResponseSchemaModel[GetFileDetail]:
    obj = await file_service.upload(db=db, file=file, user_id=request.user.id, public=public)
    return response_base.success(data=obj)


@router.get(
    '',
    summary='分页获取所有文件',
    dependencies=[
        Depends(RequestPermission('sys:file:list')),
        DependsRBAC,
        DependsPagination,
    ],
)
async def get_files_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='原始文件名')] = None,
    type: Annotated[FileType | None, Query(description='文件分类')] = None,
    ext: Annotated[str | None, Query(description='扩展名')] = None,
    created_by: Annotated[int | None, Query(description='上传人 ID')] = None,
    start_time: Annotated[str | None, Query(description='上传时间起')] = None,
    end_time: Annotated[str | None, Query(description='上传时间止')] = None,
) -> ResponseSchemaModel[PageData[GetFileDetail]]:
    page_data = await file_service.get_list(
        db=db,
        name=name,
        type=type.value if type else None,
        ext=ext,
        created_by=created_by,
        start_time=start_time,
        end_time=end_time,
    )
    return response_base.success(data=page_data)


@router.get('/statistics', summary='获取文件资源统计', dependencies=[DependsJwtAuth])
async def get_file_statistics(db: CurrentSession) -> ResponseSchemaModel[GetFileStatisticsDetail]:
    statistics = await file_service.get_statistics(db=db)
    return response_base.success(data=statistics)


@router.get('/check', summary='秒传探测', dependencies=[DependsJwtAuth])
async def check_file(
    request: Request,
    db: CurrentSession,
    sha256: Annotated[str, Query(min_length=64, max_length=64, description='文件内容 SHA-256')],
    name: Annotated[str | None, Query(description='原始文件名，与 upload 的去重口径保持一致')] = None,
    # 去重是**按子树**分开的（见 crud_file.get_by_sha256），所以探测也要带上 ——
    # 否则「/check 说命中了、upload 仍然重新传一份」，秒传白做
    *,
    public: Annotated[bool, Query(description='在公开子树里探测，与 upload 的 public 保持一致')] = False,
) -> ResponseSchemaModel[GetFileDetail | None]:
    obj = await file_service.check(db=db, sha256=sha256, user_id=request.user.id, name=name, public=public)
    # 没命中不是错误，是「这份文件还没传过」。
    # 返回 fail() 会让前端把正常的首次上传当成故障处理
    return response_base.success(data=obj)


@router.get('/targets/{target_type}/{target_id}', summary='获取业务对象的附件', dependencies=[DependsJwtAuth])
async def get_target_files(
    db: CurrentSession,
    target_type: Annotated[str, Path(max_length=32, description='业务对象类型')],
    target_id: Annotated[int, Path(description='业务对象 ID')],
) -> ResponseSchemaModel[list[GetFileDetail]]:
    files = await file_service.get_by_target(db=db, target_type=target_type, target_id=target_id)
    return response_base.success(data=files)


@router.get('/{pk}', summary='获取文件详情', dependencies=[DependsJwtAuth])
async def get_file(
    db: CurrentSession, pk: Annotated[int, Path(description='文件 ID')]
) -> ResponseSchemaModel[GetFileDetail]:
    file = await file_service.get(db=db, pk=pk)
    return response_base.success(data=file)


@router.get(
    '/{pk}/download',
    summary='下载 / 预览文件',
    dependencies=[DependsJwtAuth],
    response_class=FileResponse,
)
async def download_file(
    db: CurrentSession,
    pk: Annotated[int, Path(description='文件 ID')],
    # 直接用 Content-Disposition 的取值而不是 `download: bool` ——
    # 布尔开关要靠参数名才知道 true 是哪一边，这里的值本身就是答案
    disposition: Annotated[
        Literal['inline', 'attachment'], Query(description='inline 浏览器内联显示，attachment 强制下载')
    ] = 'inline',
) -> FileResponse:
    file, target = await file_service.resolve_path(db=db, pk=pk)

    # 原名可能带中文/空格，裸塞进 filename= 会被 header 编码规则截断或乱码。
    # RFC 6266 的两段式写法：ASCII 回退 + filename* 带 UTF-8
    ascii_name = file.original_name.encode('ascii', 'ignore').decode() or f'file.{file.ext}'
    # (issue #62) RFC 6266 的 filename="..." 是 quoted-string，`"`/`\` 必须转义，
    # 否则原名里带引号会破坏这段 header 的语法。新上传的文件在 sanitize_display_name()
    # 那一步已经挡掉了控制字符，但这条防线独立存在——万一有旧数据、或者以后
    # 又长出一条没走 sanitize_display_name() 的写入路径，这里仍然兜得住
    ascii_name = ascii_name.replace('\\', '\\\\').replace('"', '\\"')
    return FileResponse(
        target,
        media_type=file.content_type or 'application/octet-stream',
        headers={
            'Content-Disposition': (
                f'{disposition}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(file.original_name, safe="")}'
            ),
            # 预览器会按 Range 拖进度（音视频），明确声明支持
            'Accept-Ranges': 'bytes',
        },
    )


@router.delete(
    '',
    summary='批量删除文件',
    dependencies=[
        Depends(RequestPermission('sys:file:del')),
        DependsRBAC,
    ],
)
async def delete_files(db: CurrentSessionTransaction, obj: DeleteFileParam) -> ResponseModel:
    count = await file_service.delete(db=db, pks=obj.pks)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.post(
    '/relations',
    summary='挂载附件到业务对象',
    # 🔴 曾经只挂 DependsJwtAuth（仅要求登录）：前端靠 <Can perm="sys:file:upload">
    # 隐藏按钮，但任何登录用户直接调接口都能把任意 file_id 挂到任意
    # target_type/target_id 上 —— 前端隐藏按钮不是安全边界，见 AGENTS.md
    dependencies=[
        Depends(RequestPermission('sys:file:upload')),
        DependsRBAC,
    ],
)
async def attach_files(request: Request, db: CurrentSessionTransaction, obj: CreateFileRelationParam) -> ResponseModel:
    # 全部已挂载时 attach 返回 0，那是**幂等成功**而不是失败 ——
    # 这里不能照抄别处的 `if count > 0 else fail()`
    await file_service.attach(db=db, obj=obj, user_id=request.user.id)
    return response_base.success()


@router.delete(
    '/relations',
    summary='从业务对象卸载附件',
    # 同上，复用 sys:file:upload —— 卸载只解关联不删文件，没有独立的破坏性
    # 到需要单开一个权限码；和「附件面板」前端的 <Can perm="sys:file:upload"> 对齐
    dependencies=[
        Depends(RequestPermission('sys:file:upload')),
        DependsRBAC,
    ],
)
async def detach_files(db: CurrentSessionTransaction, obj: DeleteFileRelationParam) -> ResponseModel:
    await file_service.detach(db=db, obj=obj)
    return response_base.success()
