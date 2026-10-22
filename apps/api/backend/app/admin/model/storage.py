import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, UniversalStr, UniversalText, id_key


# 一行 = 一个**可选的**存储位置（另一块本地盘 / 一个 S3 兼容的桶）。
#
# 🔴 **内置的本地存储不在这张表里。** 它的两棵根目录（`UPLOAD_DIR` / `PUBLIC_UPLOAD_DIR`）
# 是代码常量，做成一行只会多出「库里的值和代码对不上」这种状态；
# 所以 `sys_file.storage_id IS NULL` = 内置本地存储，这张表一行都没有时系统行为和以前完全一样。
# 同理「默认存储」= `is_default` 的那一行，**没有任何一行是默认时就是内置本地存储**。
#
# 🔴 SecretKey 加密存（`utils/encrypt.py: AESCipher`，密钥取 `STORAGE_ENCRYPT_SECRET_KEY`），
# 详情 / 列表里**连密文都不出**，只有 `secret_hint`（同 `open_app`）。
#
# 每个存储下面固定两棵子树：`<root>/private` 与 `<root>/public`（见 `utils/storage_ops.py`）。
# `sys_file.path` 是相对子树根的 key，和内置存储同一个形状（`2026/10/21/报告_a1b2….pdf`）。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class Storage(Base):
    """系统存储表"""

    __tablename__ = 'sys_storage'
    __table_args__ = (
        sa.UniqueConstraint('code', 'deleted', name='uk_sys_storage_code_deleted'),
        {'comment': '系统存储表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='存储名称')
    # 建后不可改（`UpdateStorageParam` 里没有这个字段），同部门 / 角色编码
    code: Mapped[str] = mapped_column(UniversalStr(32), comment='存储编码')
    # `local` / `s3`。建后不可改：换类型等于换了一个存储，已有文件的 key 在新类型下没有意义
    type: Mapped[str] = mapped_column(UniversalStr(16), comment='存储类型（local：本地；s3：S3 兼容）')
    # 本地：落盘根目录（绝对路径）；S3：对象键前缀（可空）
    root: Mapped[str] = mapped_column(UniversalStr(512), default='', comment='本地根目录 / 对象键前缀')
    endpoint: Mapped[str | None] = mapped_column(UniversalStr(255), default=None, comment='S3 端点')
    bucket: Mapped[str | None] = mapped_column(UniversalStr(128), default=None, comment='S3 桶名')
    region: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='S3 区域')
    # 🔴 阿里 OSS / 腾讯 COS（2024 年后建的桶）**拒绝路径风格**，而 OpenDAL 默认就是路径风格。
    # `auto` 按 endpoint 的域名判（见 storage_ops.use_virtual_host）
    addressing: Mapped[str] = mapped_column(
        UniversalStr(16), default='auto', comment='寻址方式（auto / virtual：虚拟主机 / path：路径）'
    )
    access_key: Mapped[str | None] = mapped_column(UniversalStr(128), default=None, comment='Access Key（明文）')
    secret_cipher: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='Secret Key 密文（AES）')
    secret_hint: Mapped[str | None] = mapped_column(UniversalStr(24), default=None, comment='Secret Key 前几位')
    # 公开件的外部访问前缀（CDN / 公开桶域名），对应 `<root>/public` 这棵子树。
    # 为空 = 公开件也经后端 `/uploads` 取
    public_base_url: Mapped[str | None] = mapped_column(UniversalStr(512), default=None, comment='公开访问地址前缀')
    is_default: Mapped[bool] = mapped_column(default=False, comment='是否默认存储（新上传落这里）')
    # 停用只拦「设为默认」，**不拦读** —— 停一个存储 = 一批文件全 404 是不可接受的
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
