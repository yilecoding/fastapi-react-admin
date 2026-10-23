"""导出记录（#11 · v0.4）：我的导出 · 进度 · 下载 · 删除。

发起导出不在这里 —— 每个资源在自己的路由上开一条 `POST …/export`，挂自己的权限码
（`sys:user:export` 这种），方便 `test_permission_codes.py` 把它和前端、种子菜单三方对账。

这里的接口**只挂登录**：导出记录是个人的（同站内消息的收件箱），每个接口都按当前用户强制过滤，
不是自己的一律 404。
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from backend.app.admin.schema.export_job import GetExportJobDetail
from backend.app.admin.service.export_service import export_service
from backend.common.dataio.writers import MEDIA_TYPES
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.database.db import CurrentSession
from backend.utils.file_ops import content_disposition
from backend.utils.storage_ops import iter_read

router = APIRouter()


@router.get('', summary='我的导出记录', dependencies=[DependsJwtAuth, DependsPagination])
async def get_my_exports(
    request: Request,
    db: CurrentSession,
    status: Annotated[int | None, Query(description='状态（0：排队、1：生成中、2：完成、3：失败、4：已过期）')] = None,
) -> ResponseSchemaModel[PageData[GetExportJobDetail]]:
    page_data = await export_service.get_list(db=db, user_id=request.user.id, status=status)
    return response_base.success(data=page_data)


@router.get('/{pk}', summary='导出记录详情（轮询进度用）', dependencies=[DependsJwtAuth])
async def get_my_export(
    request: Request, db: CurrentSession, pk: Annotated[int, Path(description='导出记录 ID')]
) -> ResponseSchemaModel[GetExportJobDetail]:
    data = await export_service.get(db=db, user_id=request.user.id, pk=pk)
    return response_base.success(data=data)


@router.get(
    '/{pk}/download',
    summary='下载导出文件',
    dependencies=[DependsJwtAuth],
    response_class=FileResponse,
)
async def download_my_export(
    request: Request, db: CurrentSession, pk: Annotated[int, Path(description='导出记录 ID')]
) -> Response:
    job, target, size = await export_service.download(db=db, user_id=request.user.id, pk=pk)
    media_type = MEDIA_TYPES[job.format]
    headers = {'Content-Disposition': content_disposition(job.file_name, 'attachment', fallback=f'export.{job.format}')}
    if target.local_root is not None:
        return FileResponse(target.local_root / job.object_key, media_type=media_type, headers=headers)
    # 对象存储：后端流式代理，理由同文件下载（前端带 Authorization 头的 fetch 跟不了跨域 302）
    headers['Content-Length'] = str(size)
    return StreamingResponse(iter_read(target, job.object_key), media_type=media_type, headers=headers)


@router.delete('/{pk}', summary='删除导出记录（连同文件）', dependencies=[DependsJwtAuth])
async def delete_my_export(
    request: Request, db: CurrentSession, pk: Annotated[int, Path(description='导出记录 ID')]
) -> ResponseModel:
    await export_service.delete(db=db, user_id=request.user.id, pk=pk)
    return response_base.success()
