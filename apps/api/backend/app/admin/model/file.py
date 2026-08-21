import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, UniversalStr, id_key


class File(Base):
    """系统文件表"""

    __tablename__ = 'sys_file'
    __table_args__ = (
        # sha256 用于秒传探测，**不能唯一** —— 同一份文件允许多人各上传一次，
        # 各自有独立的归属与删除权。去重只发生在「落盘」这一层（见 file_service）
        sa.Index('ix_sys_file_sha256', 'sha256'),
        sa.Index('ix_sys_file_type_deleted', 'type', 'deleted'),
        {'comment': '系统文件表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)

    # 落盘名与展示名分离：落盘名带随机后缀（build_filename），展示名是用户看到的原名。
    # 混用会有两个后果 —— 同名文件互相覆盖，以及原名里的 `#` `?` 把 URL 切断
    name: Mapped[str] = mapped_column(UniversalStr(255), comment='存储文件名（含随机后缀）')
    original_name: Mapped[str] = mapped_column(UniversalStr(255), comment='原始文件名（展示用）')

    ext: Mapped[str] = mapped_column(UniversalStr(32), comment='小写扩展名，不带点')
    content_type: Mapped[str | None] = mapped_column(UniversalStr(255), default=None, comment='MIME 类型')
    size: Mapped[int] = mapped_column(sa.BigInteger, default=0, comment='字节数')

    # 相对落盘根目录的路径，不含前导斜杠。存相对路径而不是绝对路径 ——
    # 换部署目录 / 换机器时库里的数据不用跟着改
    path: Mapped[str] = mapped_column(UniversalStr(512), default='', comment='相对落盘根目录的存储路径')

    # 落在哪棵树上：公开子树（PUBLIC_UPLOAD_DIR，被 /uploads 静态挂出去，
    # 不登录即可读）还是私有子树（UPLOAD_DIR，只能走带 JWT 的下载接口）。
    #
    # ⚠️ 这一列不能靠 `path` 前缀推 —— 两棵树里的相对路径长得一模一样
    # （都是 `YYYY/MM/DD/名字_随机.ext`）。读盘、删盘、拼 URL 三处都要看它，
    # 推错的表现分别是 404、静默留孤儿文件、图片裂掉。
    #
    # 也不能靠 `type == 'image'` 推：图片**不都是**公开的（文件管理页正常上传的
    # 图片仍是私有的），公开性是上传时的显式选择，不是分类的推论。
    is_public: Mapped[bool] = mapped_column(default=False, comment='是否落在公开子树（不鉴权可读）')

    # 64 位 hex。用于「这个文件已经传过了」的探测，前端可据此跳过上传
    sha256: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='文件内容 SHA-256')

    # FileType 的值（image/document/video/audio/archive/other）。
    # 存字符串而不是整型：整型要靠一张对照表才读得懂，日志和 SQL 里都不友好
    type: Mapped[str] = mapped_column(UniversalStr(16), default='other', comment='文件分类')

    created_by: Mapped[int] = mapped_column(sa.BigInteger, default=0, index=True, comment='上传人 ID')


class FileRelation(Base):
    """系统文件关联表"""

    __tablename__ = 'sys_file_relation'
    __table_args__ = (
        # 同一个文件挂到同一个业务对象上只该有一条
        sa.UniqueConstraint('file_id', 'target_type', 'target_id', 'deleted', name='uk_sys_file_relation'),
        sa.Index('ix_sys_file_relation_target', 'target_type', 'target_id', 'deleted'),
        {'comment': '系统文件关联表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)

    file_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='文件 ID')

    # 业务对象类型，字符串而不是枚举/外键：新业务挂附件只需要约定一个新值，**不改表**。
    # 代价是没有数据库层的引用完整性 —— 这是刻意的取舍，附件本就允许目标先被删掉
    target_type: Mapped[str] = mapped_column(UniversalStr(32), comment='业务对象类型')
    target_id: Mapped[int] = mapped_column(sa.BigInteger, comment='业务对象 ID')

    sort: Mapped[int] = mapped_column(default=0, comment='同一目标下的排序')
    created_by: Mapped[int] = mapped_column(sa.BigInteger, default=0, comment='关联创建人 ID')
