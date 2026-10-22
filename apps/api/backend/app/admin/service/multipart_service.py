"""
分片上传（#122 第三期）：init → 逐片 PUT → complete，可续传、可取消。

- **会话在 Redis**（`FILE_MULTIPART_REDIS_PREFIX:{upload_id}` 一个 JSON + `…:parts` 一个集合），
  **分片落在目标存储的私有子树里**（`_multipart/{upload_id}/{n:05d}`）：多副本下第 2 片可能打到另一台机器，
  放本机内存或本机临时目录就拼不起来（ContiNew 的本地分片默认落 `/tmp`，就是这个坑）
- 🔴 **init 和 complete 都过一遍和普通上传同一份的校验**（`verify_upload`：扩展名白名单 + 分类大小上限 +
  公开件只收图片）。ContiNew 的 GHSA-j7qm-qprw-c53w（CVSS 8.5）就是分片入口漏了权限和白名单；complete 时再校验一次，
  挡的是「init 之后管理员把上限调低了」和「声明的大小和实际不一致」
- 每一片的大小在写入时就卡死（除最后一片外必须正好 `chunk_size`）：Starlette 先把整个 body 收完才轮到普通上传的
  大小校验，而这里是边收边数，超了当场断 —— 拿分片接口灌 2 GB 也灌不进来
- complete 把各片**按顺序流式拼**成最终对象（边拼边算 sha256），S3 上 OpenDAL 的 writer 自己再切成 multipart 传。
  代价是对象存储上的字节要读写两遍（同 Rails ActiveStorage 的 compose）—— OpenDAL 没有暴露 UploadPart / ListParts
- 会话 24 小时没有动静就过期（每传一片续一次期）；过期会话留下的分片由 `maintenance.purge_stale_multipart` 清掉
"""

import dataclasses
import hashlib
import json
import math
import re
import uuid

from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_dao
from backend.app.admin.model import File
from backend.app.admin.service.file_service import FileService
from backend.app.admin.service.storage_service import storage_service
from backend.common.enums import FileType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.file_ops import (
    build_date_dir,
    build_stored_name,
    ext_of,
    sanitize_display_name,
    strip_path,
    verify_name_and_size,
)
from backend.utils.storage_ops import (
    StorageError,
    StorageTarget,
    builtin_target,
    content_type_from_key,
    delete_object,
    iter_read,
    stat_size,
    write_stream,
)
from backend.utils.timezone import timezone

#: upload_id 的形状：32 位小写 hex。🔴 它会被拼进 Redis key 和存储里的对象 key，不校验就是注入面
UPLOAD_ID_RE = re.compile(r'^[0-9a-f]{32}$')

#: 分片目录。放在目标存储的**私有**子树里（公开子树被 `/uploads` 挂出去，半截文件不该能被读到）
PARTS_DIR = '_multipart'


def part_key(upload_id: str, part: int) -> str:
    return f'{PARTS_DIR}/{upload_id}/{part:05d}'


def verify_upload(name: str, size: int, *, public: bool) -> FileType:
    """和普通上传同一份校验：扩展名白名单 + 分类大小上限 + 公开件只收图片"""
    file_type = verify_name_and_size(name, size)
    if public:
        FileService.verify_public(file_type, ext_of(name))
    return file_type


@dataclasses.dataclass
class MultipartSession:
    upload_id: str
    user_id: int
    storage_id: int | None
    public: bool
    name: str
    size: int
    chunk_size: int
    total_parts: int
    created_at: str

    @property
    def key(self) -> str:
        return f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{self.upload_id}'

    def expected_size(self, part: int) -> int:
        """第 `part` 片应有的字节数：最后一片是余数，其余都是 chunk_size"""
        if part < self.total_parts:
            return self.chunk_size
        return self.size - self.chunk_size * (self.total_parts - 1)


def _parts_key(upload_id: str) -> str:
    return f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{upload_id}:parts'


def _lock_key(upload_id: str) -> str:
    return f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{upload_id}:lock'


class MultipartService:
    """分片上传"""

    @staticmethod
    def policy() -> dict[str, int]:
        """前端据此决定走单次上传还是分片，以及每片多大"""
        return {'chunk_threshold': settings.FILE_CHUNK_THRESHOLD, 'chunk_size': settings.FILE_CHUNK_SIZE}

    @staticmethod
    async def _parts_target(db: AsyncSession, storage_id: int | None) -> StorageTarget:
        """分片落在哪：最终对象所在存储的**私有**子树"""
        if storage_id is None:
            return builtin_target(public=False)
        storage = await storage_service.get(db=db, pk=storage_id)
        return storage_service.row_target(storage, public=False)

    @staticmethod
    async def _final_target(db: AsyncSession, session: MultipartSession) -> StorageTarget:
        if session.storage_id is None:
            return builtin_target(public=session.public)
        storage = await storage_service.get(db=db, pk=session.storage_id)
        return storage_service.row_target(storage, public=session.public)

    @staticmethod
    async def _load(upload_id: str, user_id: int) -> MultipartSession:
        """取会话。不存在、过期、不是这个人的，一律 404（403 等于告诉对方这个 upload_id 存在）"""
        if not UPLOAD_ID_RE.match(upload_id or ''):
            raise errors.NotFoundError(msg=t('error.file.upload_session_not_found'))
        raw = await redis_client.get(f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{upload_id}')
        if not raw:
            raise errors.NotFoundError(msg=t('error.file.upload_session_not_found'))
        session = MultipartSession(**json.loads(raw))
        if session.user_id != user_id:
            raise errors.NotFoundError(msg=t('error.file.upload_session_not_found'))
        return session

    @staticmethod
    async def _uploaded(upload_id: str) -> list[int]:
        members = await redis_client.smembers(_parts_key(upload_id))
        return sorted(int(m) for m in members)

    @staticmethod
    async def _touch(session: MultipartSession) -> None:
        """续期：会话和分片集合一起续，传得慢的大文件不会传到一半过期"""
        ttl = settings.FILE_MULTIPART_EXPIRE_SECONDS
        await redis_client.expire(session.key, ttl)
        await redis_client.expire(_parts_key(session.upload_id), ttl)

    @staticmethod
    def detail(session: MultipartSession, uploaded: list[int]) -> dict[str, Any]:
        return {
            'upload_id': session.upload_id,
            'name': session.name,
            'size': session.size,
            'chunk_size': session.chunk_size,
            'total_parts': session.total_parts,
            'uploaded_parts': uploaded,
        }

    @staticmethod
    async def init(*, db: AsyncSession, user_id: int, name: str, size: int, public: bool) -> dict[str, Any]:
        """
        开一个分片上传会话

        :param db: 数据库会话
        :param user_id: 上传人
        :param name: 客户端给的文件名（会过 strip_path + 控制字符清洗）
        :param size: 声明的总大小（complete 时按实际字节数再核一次）
        :param public: 落公开子树（同普通上传，只收图片）
        :return:
        """
        display = sanitize_display_name(strip_path(name))
        # 🔴 和普通上传同一份校验：扩展名白名单 + 分类大小上限 + 公开件只收图片
        verify_upload(display, size, public=public)
        if size <= 0:
            raise errors.RequestError(msg=t('error.file.empty'))
        # 落哪个存储在 init 时就定下来：传到一半有人切了默认存储，这个文件仍然完整地落在原来那个里
        target = await storage_service.upload_target(db=db, public=public)
        chunk = settings.FILE_CHUNK_SIZE
        session = MultipartSession(
            upload_id=uuid.uuid4().hex,
            user_id=user_id,
            storage_id=target.storage_id,
            public=public,
            name=display,
            size=size,
            chunk_size=chunk,
            total_parts=max(1, math.ceil(size / chunk)),
            created_at=timezone.to_iso(timezone.now()),
        )
        await redis_client.set(
            session.key, json.dumps(dataclasses.asdict(session)), ex=settings.FILE_MULTIPART_EXPIRE_SECONDS
        )
        return MultipartService.detail(session, [])

    @staticmethod
    async def status(*, upload_id: str, user_id: int) -> dict[str, Any]:
        """续传用：已经传到了哪几片"""
        session = await MultipartService._load(upload_id, user_id)
        return MultipartService.detail(session, await MultipartService._uploaded(upload_id))

    @staticmethod
    async def put_part(
        *,
        db: AsyncSession,
        upload_id: str,
        part: int,
        user_id: int,
        body: AsyncIterator[bytes],
        content_length: int | None,
    ) -> dict[str, Any]:
        """
        写一片。边收边数：超过这一片应有的大小当场断开，不等收完

        :param db: 数据库会话
        :param upload_id: 会话
        :param part: 片号（从 1 开始）
        :param user_id: 当前用户
        :param body: 请求体的字节流
        :param content_length: 请求头里声明的长度（有就先拿它挡一次）
        :return:
        """
        session = await MultipartService._load(upload_id, user_id)
        if not 1 <= part <= session.total_parts:
            raise errors.RequestError(msg=t('error.file.part_out_of_range', total=session.total_parts))
        expected = session.expected_size(part)
        if content_length is not None and content_length != expected:
            raise errors.RequestError(msg=t('error.file.part_size_mismatch', part=part, expected=expected))

        received = 0

        class _TooBigError(Exception):
            pass

        async def counted() -> AsyncIterator[bytes]:
            nonlocal received
            async for chunk in body:
                received += len(chunk)
                if received > expected:
                    raise _TooBigError
                yield chunk

        target = await MultipartService._parts_target(db, session.storage_id)
        key = part_key(upload_id, part)
        try:
            await write_stream(target, key, counted())
        except StorageError as e:
            # write_stream 把生成器里抛出的异常也包成 StorageError；超长要报成「大小不对」，不是「上传失败」
            await delete_object(target, key)
            if isinstance(e.__cause__, _TooBigError):
                raise errors.RequestError(msg=t('error.file.part_size_mismatch', part=part, expected=expected)) from e
            raise errors.RequestError(msg=t('error.file.upload_failed')) from e
        if received != expected:
            await delete_object(target, key)
            raise errors.RequestError(msg=t('error.file.part_size_mismatch', part=part, expected=expected))

        await redis_client.sadd(_parts_key(upload_id), str(part))
        await MultipartService._touch(session)
        return {'part': part, 'size': received}

    @staticmethod
    async def complete(*, db: AsyncSession, upload_id: str, user_id: int) -> File:
        """
        按顺序把各片流式拼成最终对象、落库、清掉分片和会话

        :param db: 数据库会话
        :param upload_id: 会话
        :param user_id: 当前用户
        :return:
        """
        session = await MultipartService._load(upload_id, user_id)
        uploaded = await MultipartService._uploaded(upload_id)
        missing = sorted(set(range(1, session.total_parts + 1)) - set(uploaded))
        if missing:
            raise errors.RequestError(msg=t('error.file.parts_missing', n=len(missing)))
        # 🔴 complete 时再校验一次：init 之后管理员可能调低了上限 / 收紧了白名单
        file_type = verify_upload(session.name, session.size, public=session.public)

        # 两个请求同时 complete（双击、网络重试）只让一个去拼：另一个拼出来的是第二份对象和第二条记录
        if not await redis_client.set(_lock_key(upload_id), '1', nx=True, ex=600):
            raise errors.ConflictError(msg=t('error.file.upload_finalizing'))
        try:
            return await MultipartService._assemble(db, session, file_type.value, user_id)
        finally:
            await redis_client.delete(_lock_key(upload_id))

    @staticmethod
    async def _assemble(db: AsyncSession, session: MultipartSession, file_type: str, user_id: int) -> File:
        parts_target = await MultipartService._parts_target(db, session.storage_id)
        final_target = await MultipartService._final_target(db, session)
        stored = build_stored_name(session.name)
        relative = f'{build_date_dir()}/{stored}'
        digest = hashlib.sha256()
        size = 0

        async def chained() -> AsyncIterator[bytes]:
            nonlocal size
            for n in range(1, session.total_parts + 1):
                # 先 stat：流式读取里「不存在」是第一次 read 时才抛的裸 OSError（storage_ops 的注释）
                await stat_size(parts_target, part_key(session.upload_id, n))
                async for chunk in iter_read(parts_target, part_key(session.upload_id, n)):
                    digest.update(chunk)
                    size += len(chunk)
                    yield chunk

        try:
            await write_stream(final_target, relative, chained(), content_type=content_type_from_key(stored))
        except StorageError as e:
            await delete_object(final_target, relative)
            log.error(f'合并分片 {session.upload_id} 失败：{e.reason}')
            raise errors.RequestError(msg=t('error.file.upload_failed')) from e
        if size != session.size:
            # 理论上每片写入时都卡过大小，这里对不上说明有分片被人动过 —— 宁可失败也不要落一个截断的文件
            await delete_object(final_target, relative)
            raise errors.RequestError(msg=t('error.file.size_mismatch', expected=session.size, actual=size))

        sha256 = digest.hexdigest()
        # 秒传口径同普通上传：同一人 + 同名 + 同内容 + 同存储 + 同子树
        existing = await file_dao.get_by_sha256(
            db, sha256, user_id, session.name, is_public=session.public, storage_id=session.storage_id
        )
        if existing:
            await delete_object(final_target, relative)
            record = existing
        else:
            record = await file_dao.create(
                db,
                {
                    'name': stored,
                    'original_name': session.name,
                    'ext': stored.rsplit('.', 1)[-1].lower(),
                    'content_type': content_type_from_key(stored),
                    'size': size,
                    'sha256': sha256,
                    'type': file_type,
                    'path': relative,
                    'is_public': session.public,
                    'storage_id': session.storage_id,
                    'created_by': user_id,
                },
            )
        await MultipartService._drop(parts_target, session)
        return record

    @staticmethod
    async def _drop(parts_target: StorageTarget, session: MultipartSession) -> None:
        """删分片对象和会话。分片删不掉只记日志（定时清理会再扫一遍）"""
        for n in range(1, session.total_parts + 1):
            await delete_object(parts_target, part_key(session.upload_id, n))
        await redis_client.delete(session.key, _parts_key(session.upload_id))

    @staticmethod
    async def abort(*, db: AsyncSession, upload_id: str, user_id: int) -> None:
        """取消：删分片和会话"""
        session = await MultipartService._load(upload_id, user_id)
        await MultipartService._drop(await MultipartService._parts_target(db, session.storage_id), session)


multipart_service: MultipartService = MultipartService()
