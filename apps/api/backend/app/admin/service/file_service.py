from collections.abc import Sequence
from pathlib import Path
from typing import Any

from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_dao, file_relation_dao
from backend.app.admin.model import File
from backend.app.admin.schema.file import CreateFileRelationParam, DeleteFileRelationParam
from backend.common.enums import FileType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.utils.file_ops import delete_file, upload_file, upload_file_verify, upload_root


class FileService:
    """文件服务类"""

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

    @staticmethod
    def verify_public(file_type: FileType) -> None:
        """
        公开子树的准入校验：**只有图片进得去**。

        校验放在 service 而不是接口层，也不靠调用方自觉 —— 公开子树被
        `/uploads` 无鉴权挂出去，一旦让文档/压缩包进去，
        `?public=true` 就成了「把任意文件变成公开直链」的通道。
        这个口子只为一件事存在：富文本正文里的内联图。

        ⚠️ 反过来**不成立**：图片不都该公开。文件管理页正常上传的图片
        （身份证扫描件之类）仍是私有的 —— 公开性是上传时的显式选择，
        不是「它是图片」的推论。所以这里只否掉非图片，不代替调用方做决定。

        :param file_type: 上传物的分类
        :return:
        """
        if file_type != FileType.image:
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
            FileService.verify_public(file_type)

        saved = await upload_file(file, public=public)

        # 秒传：同一个人传过**同名同内容**的文件就复用已有记录，把刚写的副本删掉。
        # 注意顺序 —— 必须先落盘才知道 sha256（流式算的），所以这里是「写完再回收」
        # 而不是「先查再写」。想省掉这次写盘得靠前端先调 /check 探测
        existing = await file_dao.get_by_sha256(db, saved.sha256, user_id, saved.original_name, is_public=public)
        if existing:
            delete_file(saved.path, public=public)
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
        return await file_dao.get_by_sha256(db, sha256, user_id, name, is_public=public)

    @staticmethod
    async def resolve_path(*, db: AsyncSession, pk: int) -> tuple[File, Path]:
        """
        解析出可直接返回给客户端的磁盘路径

        :param db: 数据库会话
        :param pk: 文件 ID
        :return:
        """
        file = await file_dao.get(db, pk)
        if not file:
            raise errors.NotFoundError(msg=t('error.file.not_found'))

        # 根目录跟着 is_public 走 —— 两棵树里的相对路径长得一模一样，
        # 写死 UPLOAD_DIR 的话公开子树里的文件在这个接口上一律 404
        root = upload_root(public=file.is_public)
        target = root / file.path
        # 库里的 path 理论上只由 build_filename 写入，但这里仍然要验 ——
        # 它是「拼路径去读磁盘」的地方，一旦哪天有人往库里写了 `../`，
        # 这个接口就成了任意文件读取
        if not target.resolve().is_relative_to(root.resolve()):
            log.error(f'拒绝越界的读取路径：{file.path!r} → {target}')
            raise errors.NotFoundError(msg=t('error.file.not_found'))

        if not target.is_file():
            # 库里有记录、盘上没文件：多半是手工清理过 static/upload。
            # 报「文件不存在」而不是 500 —— 这是数据状态问题，不是程序崩了
            log.warning(f'文件记录 {file.id} 指向的磁盘文件缺失：{target}')
            raise errors.NotFoundError(msg=t('error.file.missing'))

        return file, target

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
        # 先记下**相对路径 + 落在哪棵树**再删记录 —— 删完就查不到这两个字段了。
        # 传落盘名给 delete_file 是无效的，见那边的注释；
        # 漏掉 is_public 的表现同样是静默留孤儿（missing_ok=True 不会报错）
        targets = [(file.path, file.is_public) for file in files]

        await file_relation_dao.delete_by_file_ids(db, found_ids)
        count = await file_dao.delete(db, found_ids)

        # 磁盘删除放在最后，且失败不回滚事务（delete_file 内部只记 warning）：
        # 「库里删了、盘上留个孤儿」是可接受的；反过来「盘上删了、库里还在」
        # 会让列表里出现一批点开就 404 的行
        for path, is_public in targets:
            delete_file(path, public=is_public)

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
