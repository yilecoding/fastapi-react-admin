"""导入的错误报告（#11 · v0.4）。

模板 / 预览 / 提交在各资源自己的路由上（挂各自的权限码）；错误报告是通用的：
它里面只有导入人自己上传的那几行，所以只挂登录，按令牌的主人过滤 —— 不是自己的一律 404。
"""

from typing import Annotated

from fastapi import APIRouter, Path, Request
from fastapi.responses import Response

from backend.app.admin.service.import_service import import_service
from backend.common.security.jwt import DependsJwtAuth
from backend.utils.excel_ops import xlsx_attachment

router = APIRouter()


@router.get('/{token}/report', summary='下载导入错误报告', dependencies=[DependsJwtAuth])
async def download_import_report(
    request: Request, token: Annotated[str, Path(description='导入令牌', max_length=64)]
) -> Response:
    raw, name = await import_service.report(user=request.user, token=token)
    return xlsx_attachment(raw, name)
