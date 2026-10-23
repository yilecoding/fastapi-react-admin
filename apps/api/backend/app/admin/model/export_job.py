from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, DateTimeMixin, TimeZone, UniversalStr, UniversalText, id_key


# 一行 = 一次导出（#11 · v0.4）。小批量当场生成、大批量进 Celery，**两条路都落一行**：
# 它同时是「导出记录」页的数据、下载鉴权的依据，和「谁在什么时候按什么条件导了多少行」的审计。
#
# 🔴 文件**不进 `sys_file`**，只记 `storage_id` + `object_key`。`sys_file` 的读权限是
# 「公开的 / 自己传的 / 有 `sys:file:list` 的」—— 导出文件一进去，文件管理员就能翻出别人导的
# 用户清单，而他未必有那个资源的导出权限。导出文件只有发起人自己能下载（`export_service.download`）。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class ExportJob(DataClassBase, DateTimeMixin):
    """导出任务表"""

    __tablename__ = 'sys_export_job'
    __table_args__ = (
        # 「导出记录」按人查、按时间倒序；定时清理按状态 + 过期时间扫
        sa.Index('ix_sys_export_job_owner', 'created_by', 'created_time'),
        sa.Index('ix_sys_export_job_expire', 'status', 'expire_time'),
        {'comment': '导出任务表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    # 导出定义的登记键（`common/dataio/exporting.py`），如 `sys.user`
    resource: Mapped[str] = mapped_column(UniversalStr(64), comment='导出的资源')
    # 发起时那门语言翻好的资源名。存快照而不是每次现翻：定义改名 / 插件卸载之后记录照样看得懂
    title: Mapped[str] = mapped_column(UniversalStr(128), comment='资源名（快照）')
    format: Mapped[str] = mapped_column(UniversalStr(8), comment='文件格式（xlsx / csv）')
    # 筛选条件 · 列 · 选中的行 · 快照上界（`max_id`）。执行就按这一份来，不再看请求
    params: Mapped[str] = mapped_column(UniversalText, comment='导出参数 JSON')
    # 后台任务里没有请求上下文，表头、文件名、站内消息都按这个语言出
    language: Mapped[str] = mapped_column(UniversalStr(16), comment='发起时的界面语言')
    created_by: Mapped[int] = mapped_column(sa.BigInteger, comment='发起人 ID')
    status: Mapped[int] = mapped_column(default=0, comment='状态（0：排队、1：生成中、2：完成、3：失败、4：已过期）')
    total: Mapped[int] = mapped_column(default=0, comment='发起时按条件数出的行数')
    # 生成中是「已经写了多少行」（每批更新一次，界面拿它画进度），完成后是最终行数
    row_count: Mapped[int | None] = mapped_column(default=None, comment='已写出的行数')
    file_name: Mapped[str] = mapped_column(UniversalStr(255), default='', comment='下载文件名')
    file_size: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='文件字节数')
    # 审计用：一份流出去的文件，拿它的 SHA-256 能对上是哪一次、谁导出的
    file_sha256: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='文件 SHA-256')
    # 文件落在哪个存储（NULL = 内置本地存储），同 `sys_file.storage_id`：读 / 删一律按这一列，不按当前默认存储
    storage_id: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='文件所在存储')
    object_key: Mapped[str | None] = mapped_column(UniversalStr(512), default=None, comment='文件在存储里的 key')
    # 给用户看的原因（已按发起语言翻好）。原始异常只进日志 —— 里面可能带 SQL 和库结构
    error: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='失败原因')
    task_id: Mapped[str | None] = mapped_column(
        UniversalStr(64), default=None, comment='Celery 任务 ID（后台导出才有）'
    )
    started_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='开始生成的时间')
    finished_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='结束时间（成功或失败）')
    # 到这个时间文件就删了，记录留着（状态改成「已过期」），审计不随文件一起消失
    expire_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='文件过期时间')
    download_count: Mapped[int] = mapped_column(default=0, comment='下载次数')
