from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import anyio

from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_dao, file_relation_dao
from backend.app.admin.model import File
from backend.app.admin.schema.file import CreateFileRelationParam, DeleteFileRelationParam
from backend.app.admin.service.storage_service import storage_service
from backend.common.enums import FileType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.common.security.data_scope import bypass_data_scope
from backend.core.conf import settings
from backend.utils.file_ops import get_file_ext, upload_file, upload_file_verify
from backend.utils.storage_ops import (
    StorageError,
    StorageTarget,
    content_type_from_key,
    delete_object,
    presign_read,
    stat_size,
)

#: 业务模块登记的「这个人能不能读这个文件」。签名：`(db, request.user, file) -> bool`
FileAccessChecker = Callable[[AsyncSession, Any, File], Awaitable[bool]]
_ACCESS_CHECKERS: list[FileAccessChecker] = []


def register_file_access(checker: FileAccessChecker) -> None:
    """业务模块在自己的模块里登记（通知公告、审批……）。

    文件模块是底座，**不 import 任何业务插件**：「挂在一条公告上的附件谁能看」只有公告自己知道，
    插件卸载了它的登记也就跟着没了
    """
    _ACCESS_CHECKERS.append(checker)


def _has_perm(user: Any, code: str) -> bool:
    """权限码的算法和 `rbac_verify` 一致：启用的角色 × 启用的菜单"""
    if getattr(user, 'is_superuser', False):
        return True
    for role in getattr(user, 'roles', None) or []:
        if role.status != 1:
            continue
        for menu in role.menus or []:
            if menu.perms and menu.status == 1 and code in menu.perms.split(','):
                return True
    return False


class FileService:
    """文件服务类"""

    @staticmethod
    async def can_read(*, db: AsyncSession, user: Any, file: File) -> bool:
        """能不能读这个私有文件（下载 / 详情 / 附件列表都走这一个判断）。

        🔴 原来只要登录就能按 ID 下载任何人的私有文件 —— 雪花 ID 不是秘密（URL、日志、
        审批单的表单数据里都有）。现在：公开的 / 自己传的 / 文件管理员 / 业务模块说可以的，才给。
        """
        if file.is_public or file.created_by == user.id or _has_perm(user, 'sys:file:list'):
            return True
        for checker in _ACCESS_CHECKERS:
            if await checker(db, user, file):
                return True
        return False

    @staticmethod
    async def get_readable(*, db: AsyncSession, user: Any, pk: int) -> File:
        """取一个**这个人能读**的文件。读不了报 404 而不是 403：403 等于告诉对方「这个 ID 存在」

        🔴 取文件要 `bypass_data_scope()`：下载 / 详情只挂登录，而 `CRUDFile` 是按数据范围过滤的 ——
        种子里 STAFF 那种「开了过滤、一个范围都没配」的角色**一个文件都看不见**，连公告附件、
        自己传的文件都下不了（security 分册「没有权限门禁的端点，绝不能挂 scoped 的 DAO」）。
        能不能读由 `can_read` 说了算，不归数据范围管
        """
        with bypass_data_scope():
            file = await file_dao.get(db, pk)
        if not file or not await FileService.can_read(db=db, user=user, file=file):
            raise errors.NotFoundError(msg=t('error.file.not_found'))
        return file

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> File:
        """
        获取文件

        :param db: 数据库会话
        :param pk: 文件 ID
        :return:
        """
        file = await file_dao.get(db, pk)
        if not file:
            raise errors.NotFoundError(msg=t('error.file.not_found'))
        return file

    @staticmethod
    async def get_list(
        *,
        db: AsyncSession,
        name: str | None,
        type: str | None,
        ext: str | None,
        created_by: int | None,
        start_time: str | None,
        end_time: str | None,
    ) -> dict[str, Any]:
        """
        获取文件列表

        :param db: 数据库会话
        :param name: 原始文件名（模糊）
        :param type: 文件分类
        :param ext: 扩展名
        :param created_by: 上传人 ID
        :param start_time: 上传时间起
        :param end_time: 上传时间止
        :return:
        """
        file_select = await file_dao.get_select(name, type, ext, created_by, start_time, end_time)
        return await paging_data(db, file_select)

    # 🔴 SVG 是可执行的 XML 文档（能带 <script>/onload），落进无鉴权的 /uploads
    # 静态子树、被当成独立文档直接导航打开，就是一个完整的存储型 XSS —— 能读到
    # sessionStorage 里的 access token（token-store.ts 就存在这里）。`ico` 是纯
    # 二进制图标格式，没有脚本执行面，不受影响。前端 file-icon.tsx 的
    # canThumbnail 早就因为同样的理由把 svg 排除在缩略图之外，但那个认知没有
    # 延伸到"能不能进公开子树"这条更危险的路径——这里补上。
    _PUBLIC_UNSAFE_IMAGE_EXTS = frozenset({'svg'})

    @staticmethod
    def verify_public(file_type: FileType, file_ext: str) -> None:
        """
        公开子树的准入校验：**只有图片进得去，且不能是可执行的图片格式**。

        校验放在 service 而不是接口层，也不靠调用方自觉 —— 公开子树被
        `/uploads` 无鉴权挂出去，一旦让文档/压缩包进去，
        `?public=true` 就成了「把任意文件变成公开直链」的通道。
        这个口子只为一件事存在：富文本正文里的内联图。

        ⚠️ 反过来**不成立**：图片不都该公开。文件管理页正常上传的图片
        （身份证扫描件之类）仍是私有的 —— 公开性是上传时的显式选择，
        不是「它是图片」的推论。所以这里只否掉非图片，不代替调用方做决定。

        :param file_type: 上传物的分类
        :param file_ext: 小写扩展名，不带点
        :return:
        """
        if file_type != FileType.image or file_ext in FileService._PUBLIC_UNSAFE_IMAGE_EXTS:
            raise errors.RequestError(msg=t('error.file.public_link_images_only'))

    @staticmethod
    async def upload(*, db: AsyncSession, file: UploadFile, user_id: int, public: bool = False) -> File:
        """
        上传文件并落库

        :param db: 数据库会话
        :param file: FastAPI 上传文件对象
        :param user_id: 上传人 ID
        :param public: 落公开子树（无鉴权直链），仅富文本内联图使用
        :return:
        """
        file_type = upload_file_verify(file)
        # 先否掉再落盘 —— 反过来的话非法文件已经写进公开目录了，
        # 就算接着 raise，那个可读的直链在磁盘上已经存在过一瞬
        if public:
            FileService.verify_public(file_type, get_file_ext(file))

        # 落到**当前默认存储**（没有默认 = 内置本地存储）。之后读 / 删都按记录上的 storage_id 走
        target = await storage_service.upload_target(db=db, public=public)
        saved = await upload_file(file, public=public, target=target)

        # 秒传：同一个人传过**同名同内容**的文件就复用已有记录，把刚写的副本删掉。
        # 注意顺序 —— 必须先落盘才知道 sha256（流式算的），所以这里是「写完再回收」
        # 而不是「先查再写」。想省掉这次写盘得靠前端先调 /check 探测
        existing = await file_dao.get_by_sha256(
            db, saved.sha256, user_id, saved.original_name, is_public=public, storage_id=target.storage_id
        )
        if existing:
            await delete_object(target, saved.path)
            return existing

        return await file_dao.create(
            db,
            {
                'name': saved.name,
                'original_name': saved.original_name,
                'ext': saved.ext,
                'content_type': saved.content_type,
                'size': saved.size,
                'sha256': saved.sha256,
                'type': file_type.value,
                'path': saved.path,
                'is_public': saved.is_public,
                'storage_id': target.storage_id,
                'created_by': user_id,
            },
        )

    @staticmethod
    async def check(
        *, db: AsyncSession, sha256: str, user_id: int, name: str | None = None, public: bool = False
    ) -> File | None:
        """
        秒传探测：这份内容我传过吗

        带 `name` 时问的是「同名同内容传过吗」—— 和 `upload` 的去重口径一致，
        命中就真能跳过上传。不带 `name` 只问内容，命中不保证 upload 也会复用。

        :param db: 数据库会话
        :param sha256: 文件内容 SHA-256
        :param user_id: 上传人 ID
        :param name: 原始文件名
        :param public: 只在同一棵子树里探测 —— 和 `upload` 的去重口径必须一致，
            否则「/check 说命中了、upload 还是重新传一份」
        :return:
        """
        # 口径和 upload 一致：只在**新上传会落的那个存储**里找。只要 id，别为一次探测去解密密钥、建 operator
        storage_id = await storage_service.default_storage_id(db=db)
        return await file_dao.get_by_sha256(db, sha256, user_id, name, is_public=public, storage_id=storage_id)

    @staticmethod
    async def resolve(*, db: AsyncSession, pk: int, user: Any) -> tuple[File, StorageTarget, int]:
        """
        找到文件、它所在的存储和对象的实际大小（先过「这个人能不能读」）。存储里没有这个对象时报「文件已丢失」

        大小从存储现查而不是拿 `sys_file.size`：代理下载要靠它发 Content-Length（浏览器才有进度条），
        两边对不上时宁可报「文件已丢失」也不要发一个截断的响应

        :param db: 数据库会话
        :param pk: 文件 ID
        :param user: 当前用户（`request.user`）
        :return:
        """
        file = await FileService.get_readable(db=db, user=user, pk=pk)
        target = await storage_service.target_for_file(db=db, file=file)

        if target.local_root is not None:
            local = target.local_root / file.path
            root = target.local_root

            def _probe() -> int:
                # 在线程里做 realpath / stat（同 uploads.py）：表里的本地存储多半是 NAS 挂载，挂死时别把事件循环带走。
                # 库里的 path 理论上只由 build_filename 写入，但这里仍然要验 ——
                # 它是「拼路径去读磁盘」的地方，一旦哪天有人往库里写了 `../`，这个接口就成了任意文件读取
                if not local.resolve().is_relative_to(root.resolve()):
                    return -2
                # 库里有记录、盘上没文件：多半是手工清理过上传目录。报「文件不存在」而不是 500
                return local.stat().st_size if local.is_file() else -1

            size = await anyio.to_thread.run_sync(_probe)
            if size == -2:
                log.error(f'拒绝越界的读取路径：{file.path!r} → {local}')
                raise errors.NotFoundError(msg=t('error.file.not_found'))
            if size == -1:
                log.warning(f'文件记录 {file.id} 指向的磁盘文件缺失：{local}')
                raise errors.NotFoundError(msg=t('error.file.missing'))
            return file, target, size

        try:
            size = await stat_size(target, file.path)
        except StorageError as e:
            if e.reason in ('not_found', 'invalid_key'):
                log.warning(f'文件记录 {file.id} 指向的对象缺失：{target.storage_id}:{file.path}')
                raise errors.NotFoundError(msg=t('error.file.missing')) from e
            raise errors.ServerError(msg=t('error.storage.read_failed')) from e
        return file, target, size

    @staticmethod
    async def presign(*, db: AsyncSession, file: File, disposition: str) -> str | None:
        """
        短时效的直连下载地址。**只有对象存储有**，本地存储返回 None（前端回落到带鉴权的下载接口）

        🔴 调用方必须先过 `get_readable`（这里收的是已经判过「能读」的记录）：
        预签名 URL 签出去就撤不回来，有效期内谁拿到都能下

        :param db: 数据库会话
        :param file: 已经判过可读的文件记录
        :param disposition: Content-Disposition 头的完整取值
        :return:
        """
        target = await storage_service.target_for_file(db=db, file=file)
        if not target.can_presign:
            return None
        try:
            return await presign_read(
                target,
                file.path,
                expire=settings.STORAGE_PRESIGN_EXPIRE_SECONDS,
                content_disposition=disposition,
                content_type=content_type_from_key(file.path),
            )
        except StorageError as e:
            raise errors.ServerError(msg=t('error.storage.read_failed')) from e

    @staticmethod
    async def _target_or_none(*, db: AsyncSession, file: File) -> StorageTarget | None:
        """删除用：存储已经没了就返回 None —— 记录照删，对象没处可删"""
        try:
            return await storage_service.target_for_file(db=db, file=file)
        except errors.BaseExceptionError:
            log.warning(f'删除文件 {file.id} 时找不到它的存储 {file.storage_id}，只删记录')
            return None

    @staticmethod
    async def delete(*, db: AsyncSession, pks: list[int]) -> int:
        """
        批量删除文件（记录 + 关联 + 磁盘文件）

        :param db: 数据库会话
        :param pks: 文件 ID 列表
        :return:
        """
        files = await file_dao.get_by_ids(db, pks)
        if not files:
            return 0

        found_ids = [file.id for file in files]
        # 先解析出**每个文件自己的存储 + 子树**再删记录 —— 删完就查不到这几个字段了。
        # 漏掉 is_public / storage_id 的表现都是静默留孤儿（删一个不存在的对象不报错）
        # 存储按 (storage_id, is_public) 只解析一次：200 个文件在同一个 S3 上就是 200 次查表 + 解密，没必要
        resolved: dict[tuple[int | None, bool], StorageTarget | None] = {}
        targets: list[tuple[StorageTarget, str]] = []
        for file in files:
            group = (file.storage_id, file.is_public)
            if group not in resolved:
                resolved[group] = await FileService._target_or_none(db=db, file=file)
            target = resolved[group]
            if target is not None:
                targets.append((target, file.path))

        await file_relation_dao.delete_by_file_ids(db, found_ids)
        count = await file_dao.delete(db, found_ids)

        # 磁盘删除放在最后，且失败不回滚事务（delete_file 内部只记 warning）：
        # 「库里删了、盘上留个孤儿」是可接受的；反过来「盘上删了、库里还在」
        # 会让列表里出现一批点开就 404 的行
        for target, path in targets:
            await delete_object(target, path)

        return count

    @staticmethod
    async def get_statistics(*, db: AsyncSession) -> dict[str, Any]:
        """
        文件资源统计

        :param db: 数据库会话
        :return:
        """
        rows = await file_dao.get_statistics(db)

        type_counts = {row.type: int(row.count) for row in rows}
        type_sizes = {row.type: int(row.size) for row in rows}
        return {
            'total_count': sum(type_counts.values()),
            'total_size': sum(type_sizes.values()),
            'type_counts': type_counts,
            'type_sizes': type_sizes,
        }

    @staticmethod
    async def get_by_target(*, db: AsyncSession, target_type: str, target_id: int) -> Sequence[File]:
        """
        获取某个业务对象的附件（保持关联表里的 sort 顺序）

        :param db: 数据库会话
        :param target_type: 业务对象类型
        :param target_id: 业务对象 ID
        :return:
        """
        file_ids = await file_relation_dao.get_file_ids_by_target(db, target_type, target_id)
        if not file_ids:
            return []

        # 同 `get_readable`：不按数据范围过滤，调用方（附件列表接口）逐个过 `can_read`
        with bypass_data_scope():
            files = await file_dao.get_by_ids(db, list(file_ids))
        # select_models 的返回顺序跟着数据库走，不保证和 file_ids 一致 ——
        # 附件的显示顺序是用户排过的，必须按关联表的顺序重排回来
        by_id = {file.id: file for file in files}
        return [by_id[fid] for fid in file_ids if fid in by_id]

    @staticmethod
    async def attach(*, db: AsyncSession, obj: CreateFileRelationParam, user_id: int) -> int:
        """
        把文件挂到业务对象上

        :param db: 数据库会话
        :param obj: 挂载参数
        :param user_id: 操作人 ID
        :return:
        """
        files = await file_dao.get_by_ids(db, obj.file_ids)
        if len(files) != len(set(obj.file_ids)):
            raise errors.NotFoundError(msg=t('error.file.some_not_found'))

        existing = set(await file_relation_dao.get_existing_file_ids(db, obj.target_type, obj.target_id, obj.file_ids))
        # 幂等：已经挂上的跳过而不是报错。附件面板重复提交是常态
        pending = [fid for fid in obj.file_ids if fid not in existing]
        if not pending:
            return 0

        base_sort = await file_relation_dao.get_max_sort(db, obj.target_type, obj.target_id)
        return await file_relation_dao.bulk_create(
            db,
            [
                {
                    'file_id': fid,
                    'target_type': obj.target_type,
                    'target_id': obj.target_id,
                    'sort': base_sort + offset,
                    'created_by': user_id,
                }
                for offset, fid in enumerate(pending, start=1)
            ],
        )

    @staticmethod
    async def detach(*, db: AsyncSession, obj: DeleteFileRelationParam) -> int:
        """
        把文件从业务对象上卸下来（只删关联，不删文件本身）

        :param db: 数据库会话
        :param obj: 卸载参数
        :return:
        """
        return await file_relation_dao.delete_by_target(db, obj.target_type, obj.target_id, obj.file_ids)


file_service: FileService = FileService()
