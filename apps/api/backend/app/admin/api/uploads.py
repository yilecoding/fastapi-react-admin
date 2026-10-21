"""
`/uploads/{key}` —— 公开件（富文本内联图、头像）的无鉴权读取入口

原来是一条 `StaticFiles` 挂载直接对着 `PUBLIC_UPLOAD_DIR`。有了多存储之后公开件可能在 S3 上，
所以改成先按 key 反查文件记录、再去**它自己的**存储取。**URL 形状不变**：已经存进富文本正文和
头像字段里的 `/uploads/2026/…/x.png` 一个都不用改，换默认存储也不会让它们失效。

- 本地类存储：直接回字节（`FileResponse`，自带 Range / ETag）
- S3 + 配了 `public_base_url`（CDN / 公开桶）：302 过去
- S3 没配：302 到一个短时效的预签名地址。`<img src>` 跟重定向不带任何凭据，没有
  下载接口那种「Authorization 头 + 跨域重定向」的问题
"""

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Path
from fastapi.responses import FileResponse, RedirectResponse, Response

from backend.app.admin.crud.crud_file import file_dao
from backend.app.admin.service.storage_service import storage_service
from backend.common.exception import errors
from backend.common.log import log
from backend.core.conf import settings
from backend.database.db import CurrentSession
from backend.utils.storage_ops import StorageError, check_key, presign_read

router = APIRouter()

#: 这棵子树只给 `<img src>` 加载，没有任何功能需要脚本 / 样式（issue #56 的纵深防御）。
#: SVG 已经在 `FileService.verify_public()` 挡在门外，这层头是万一有格式绕过了准入时的第二道闸
_HARDENING_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
}

#: key 带 16 位随机后缀、内容不会变，可以放心缓存；但不给到一年 —— 删掉的头像还挂在别人浏览器里一年不合适
_CACHE_PUBLIC = 'public, max-age=86400'


def _not_found() -> Response:
    # 纯文本 404，和原来 StaticFiles 的行为一致（这条路给 <img> 用，不是给接口调用方的）
    return Response('Not Found', status_code=404, media_type='text/plain', headers=_HARDENING_HEADERS)


@router.api_route('/uploads/{key:path}', methods=['GET', 'HEAD'], include_in_schema=False)
async def get_public_upload(db: CurrentSession, key: Annotated[str, Path()]) -> Response:
    try:
        key = check_key(key)
    except StorageError:
        return _not_found()

    file = await file_dao.get_public_by_path(db, key)
    if file is None:
        return _not_found()
    try:
        target = await storage_service.target_for_file(db=db, file=file)
    except errors.BaseExceptionError:
        return _not_found()

    if target.local_root is not None:
        local = target.local_root / key
        if not local.resolve().is_relative_to(target.local_root.resolve()) or not local.is_file():
            return _not_found()
        return FileResponse(
            local,
            media_type=file.content_type or None,
            headers={**_HARDENING_HEADERS, 'Cache-Control': _CACHE_PUBLIC},
        )

    if target.public_base_url:
        return RedirectResponse(
            f'{target.public_base_url}/{quote(key, safe="/")}',
            status_code=302,
            headers={'Cache-Control': _CACHE_PUBLIC},
        )

    expire = settings.STORAGE_PRESIGN_EXPIRE_SECONDS
    try:
        url = await presign_read(
            target, key, expire=expire, content_disposition='inline', content_type=file.content_type
        )
    except StorageError:
        log.warning(f'公开文件 {file.id} 签发地址失败')
        return _not_found()
    # 重定向本身的缓存必须**短于**签名有效期，否则浏览器会拿着一个已经过期的地址去请求
    return RedirectResponse(url, status_code=302, headers={'Cache-Control': f'private, max-age={max(expire // 2, 0)}'})
