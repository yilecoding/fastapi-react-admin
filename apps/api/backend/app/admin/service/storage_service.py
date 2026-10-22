from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_dao
from backend.app.admin.crud.crud_storage import storage_dao
from backend.app.admin.model import File, Storage
from backend.app.admin.schema.storage import CreateStorageParam, TestStorageResult, UpdateStorageParam
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.core.path_conf import BASE_PATH, STATIC_DIR
from backend.utils.encrypt import AESCipher
from backend.utils.storage_ops import (
    StorageError,
    StorageTarget,
    builtin_target,
    check_endpoint,
    probe,
    row_target,
)

#: 内置本地存储在接口上的 id / code。它不是表里的一行（见 model/storage.py）
BUILTIN_ID = 'builtin'
BUILTIN_CODE = 'LOCAL'


def _cipher() -> AESCipher:
    """取加密器。🔴 没配密钥就拒绝保存，不静默存明文（同 AI 供应商 / 能力开放）"""
    key = settings.STORAGE_ENCRYPT_SECRET_KEY
    if not key:
        raise errors.ServerError(msg=t('error.storage.encrypt_key_unset'))
    try:
        return AESCipher(key)
    except ValueError as e:
        raise errors.ServerError(msg=t('error.storage.encrypt_key_invalid')) from e


def _secret_hint(secret: str) -> str:
    # 短密钥全掩：8 位以内露首尾等于露出大半个
    return '*' * len(secret) if len(secret) <= 8 else f'{secret[:4]}{"*" * 6}'


async def _endpoint_or_raise(endpoint: str) -> str:
    try:
        return await check_endpoint(endpoint)
    except StorageError as e:
        raise errors.RequestError(msg=t(f'error.storage.{e.reason}')) from e


def _check_local_root(root: str) -> str:
    """
    本地存储的根目录：绝对路径，且不能在 `STATIC_DIR` 或应用自己的目录（`BASE_PATH`）下面

    🔴 前一条不是洁癖：`/static` 是**无鉴权**挂出去的，根目录放进去 = 私有文件对任何人可读。
    当初 `UPLOAD_DIR` 就是因为在 `STATIC_DIR` 里面才被连带公开过（见 registrar.py）。
    后一条：根目录会被 `mkdir -p` 并写入用户上传的任意字节，指到源码 / `alembic/` / `plugin/` 下面没有任何正当用途。
    ⚠️ 其余系统目录（`/etc`、`/var/www`…）**没有拦**：能配存储的是 `sys:storage:edit`（管理员级权限），
    要收紧只能靠部署时的挂载点白名单，不在这一层猜
    """
    path = Path(root)
    if not root or not path.is_absolute():
        raise errors.RequestError(msg=t('error.storage.local_root_invalid'))
    resolved = path.resolve()
    if resolved == Path('/') or any(resolved.is_relative_to(d.resolve()) for d in (STATIC_DIR, BASE_PATH)):
        raise errors.RequestError(msg=t('error.storage.local_root_invalid'))
    return str(resolved)


class StorageService:
    """存储管理"""

    @staticmethod
    def builtin_detail(*, is_default: bool, file_count: int) -> dict[str, Any]:
        """内置本地存储在列表里的那一行"""
        return {
            'id': BUILTIN_ID,
            'name': t('storage.builtin_name'),
            'code': BUILTIN_CODE,
            'type': 'local',
            'root': '',
            'addressing': 'auto',
            'is_default': is_default,
            'status': 1,
            'builtin': True,
            'file_count': file_count,
        }

    @staticmethod
    async def get_list(*, db: AsyncSession) -> list[dict[str, Any]]:
        """全部存储：内置那一行在最前，其后是表里的（数量少，不分页）"""
        rows = await storage_dao.get_all(db)
        counts = await file_dao.get_storage_counts(db)
        has_default = any(row.is_default for row in rows)
        result = [StorageService.builtin_detail(is_default=not has_default, file_count=counts.get(None, 0))]
        for row in rows:
            detail = {c.name: getattr(row, c.name) for c in Storage.__table__.columns if c.name != 'secret_cipher'}
            detail['builtin'] = False
            detail['file_count'] = counts.get(row.id, 0)
            result.append(detail)
        return result

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Storage:
        storage = await storage_dao.get(db, pk)
        if not storage:
            raise errors.NotFoundError(msg=t('error.storage.not_found'))
        return storage

    @staticmethod
    async def _normalize(storage_type: str, data: dict[str, Any], *, secret_required: bool) -> dict[str, Any]:
        """按类型收拾字段：本地的 S3 字段清空，S3 的必填项补齐校验"""
        if storage_type == 'local':
            data['root'] = _check_local_root(data.get('root') or '')
            for key in ('endpoint', 'bucket', 'region', 'access_key', 'public_base_url'):
                data[key] = None
            data['addressing'] = 'auto'
            return data
        if not data.get('endpoint') or not data.get('bucket') or not data.get('access_key') or secret_required:
            raise errors.RequestError(msg=t('error.storage.s3_fields_required'))
        data['endpoint'] = await _endpoint_or_raise(data['endpoint'])
        data['root'] = (data.get('root') or '').strip('/')
        return data

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateStorageParam) -> Storage:
        if await storage_dao.get_by_code(db, obj.code):
            raise errors.ConflictError(msg=t('error.storage.code_exists', code=obj.code))
        data = obj.model_dump(exclude={'secret_key'})
        secret = (obj.secret_key or '').strip()
        data = await StorageService._normalize(obj.type, data, secret_required=obj.type == 's3' and not secret)
        if obj.type == 's3':
            data['secret_cipher'] = _cipher().encrypt(secret.encode()).hex()
            data['secret_hint'] = _secret_hint(secret)
        storage = Storage(**data)
        db.add(storage)
        await db.flush()
        return storage

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateStorageParam) -> int:
        storage = await StorageService.get(db=db, pk=pk)
        data = obj.model_dump(exclude={'secret_key'})
        secret = (obj.secret_key or '').strip()
        data = await StorageService._normalize(
            storage.type, data, secret_required=storage.type == 's3' and not secret and not storage.secret_cipher
        )
        if storage.type == 's3' and secret:
            data['secret_cipher'] = _cipher().encrypt(secret.encode()).hex()
            data['secret_hint'] = _secret_hint(secret)
        # `updated_time` 由 onupdate 刷新 —— 它就是各副本 operator 缓存的版本号（storage_ops._ROW_OPERATORS）
        return await storage_dao.update_model(db, pk, data)

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        storage = await StorageService.get(db=db, pk=pk)
        if storage.is_default:
            raise errors.RequestError(msg=t('error.storage.default_cannot_delete'))
        count = (await file_dao.get_storage_counts(db)).get(pk, 0)
        if count:
            # 🔴 删了存储，挂在它上面的文件就全读不到了 —— 而且是在别人打开时才 404
            raise errors.RequestError(msg=t('error.storage.has_files', count=count))
        return await storage_dao.delete(db, pk)

    @staticmethod
    async def set_default(*, db: AsyncSession, pk: int | None) -> None:
        """设默认存储。`pk=None` = 回到内置本地存储。只影响**新**上传，老文件按自己的 storage_id 读"""
        if pk is not None:
            storage = await StorageService.get(db=db, pk=pk)
            if storage.status != 1:
                raise errors.RequestError(msg=t('error.storage.disabled_cannot_default'))
        await storage_dao.clear_default(db)
        if pk is not None:
            await storage_dao.update_model(db, pk, {'is_default': True})

    @staticmethod
    async def set_status(*, db: AsyncSession, pk: int, status: int) -> int:
        storage = await StorageService.get(db=db, pk=pk)
        if status != 1 and storage.is_default:
            raise errors.RequestError(msg=t('error.storage.default_cannot_disable'))
        return await storage_dao.update_model(db, pk, {'status': status})

    @staticmethod
    async def test(*, db: AsyncSession, pk: int) -> TestStorageResult:
        """测试连接（写 → 读 → 删一个探测对象）。🔴 失败原因只给归类后的人话，上游原文只进日志"""
        storage = await StorageService.get(db=db, pk=pk)
        try:
            await probe(StorageService.row_target(storage, public=False))
        except StorageError as e:
            return TestStorageResult(ok=False, message=t(f'error.storage.probe_{e.reason}'))
        return TestStorageResult(ok=True, message=t('storage.probe_ok'))

    # ─── 给文件服务用的解析 ───────────────────────────────────────────────

    @staticmethod
    def row_target(storage: Storage, *, public: bool) -> StorageTarget:
        try:
            # 解密也在 try 里：换过 STORAGE_ENCRYPT_SECRET_KEY / 密文损坏时 AES 解填充抛的是裸 ValueError，
            # 放外面的话 /uploads、批量删除、上传全部 500 而不是「存储不可用」
            secret = None
            if storage.type == 's3' and storage.secret_cipher:
                secret = _cipher().decrypt(storage.secret_cipher)
            return row_target(storage, public=public, secret_key=secret)
        except errors.BaseExceptionError:
            raise
        except Exception as e:
            log.error(f'构造存储 {storage.id} 失败：{e!s}')
            raise errors.ServerError(msg=t('error.storage.read_failed')) from e

    @staticmethod
    async def default_storage_id(*, db: AsyncSession) -> int | None:
        """默认存储的 id（None = 内置本地存储）。只要 id 的地方用这个，别去建 operator"""
        storage = await storage_dao.get_default(db)
        return storage.id if storage else None

    @staticmethod
    async def upload_target(*, db: AsyncSession, public: bool) -> StorageTarget:
        """新上传落哪：默认存储；没有默认 = 内置本地存储"""
        storage = await storage_dao.get_default(db)
        if storage is None:
            return builtin_target(public=public)
        return StorageService.row_target(storage, public=public)

    @staticmethod
    async def target_for_file(*, db: AsyncSession, file: File) -> StorageTarget:
        """文件**自己**所在的存储（不是当前默认存储）"""
        if file.storage_id is None:
            return builtin_target(public=file.is_public)
        storage = await storage_dao.get(db, file.storage_id)
        if storage is None:
            log.warning(f'文件 {file.id} 指向的存储 {file.storage_id} 已不存在')
            raise errors.NotFoundError(msg=t('error.file.missing'))
        return StorageService.row_target(storage, public=file.is_public)


storage_service: StorageService = StorageService()
