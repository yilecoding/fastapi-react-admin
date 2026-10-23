"""新增导出任务表（sys_export_job）、导入导出的权限按钮、「清理过期导出」调度（#11 · v0.4）

Revision ID: o0000000dataio
Revises: n0000000multipart
Create Date: 2026-10-22 20:00:00

建表和菜单放在一条里，理由同 `k0000000openapp`：只建表不补菜单，表现是功能装好了但按钮一个都点不到
（导出接口挂的是 `sys:user:export` 这类新权限码，库里没有这条菜单就没有角色能被授权）。

🔴 手写的建表要自己写 `autoincrement=False`：autogenerate 渲染不出模型侧的 Python 默认值，
SQL Server 上会把雪花主键建成 IDENTITY，那张表在生产里一行都写不进去（alembic 分册）。

权限按钮刻意**不授权给任何非超管角色**：哪些角色能导出 / 导入是每套部署自己的产品决定
（同 AI 插件的种子菜单）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'o0000000dataio'
down_revision = 'n0000000multipart'
branch_labels = None
depends_on = None

#: 和种子文件同一套 ID（`sql/*/init_snowflake_test_data.sql` · `plugin/{dict,notice}/sql/*/init_snowflake.sql`），
#: 升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, perms, sort, parent_name, plugin)
_MENUS = [
    (2049629108253622350, 'ExportSysUser', '导出', 'sys:user:export', 2, 'SysUser', None),
    (2049629108253622351, 'ExportSysDept', '导出', 'sys:dept:export', 3, 'SysDept', None),
    (2049629108253622352, 'ImportSysDept', '导入', 'sys:dept:import', 4, 'SysDept', None),
    (2049629108253622353, 'ExportLoginLog', '导出', 'log:login:export', 3, 'LoginLog', None),
    (2049629108253622354, 'ExportOperaLog', '导出', 'log:opera:export', 4, 'OperaLog', None),
    (2049629108253622355, 'ExportDictData', '导出数据', 'dict:data:export', 0, 'PluginDict', 'dict'),
    (2049629108253622356, 'ImportDictData', '导入数据', 'dict:data:import', 0, 'PluginDict', 'dict'),
    (2049629108253622357, 'ExportNotice', '导出', 'sys:notice:export', 0, 'PluginNotice', 'notice'),
]

_SCHEDULER_ID = 2049629108253622358
_SCHEDULER_NAME = '清理过期导出'
_REMARK = (
    '导出文件过了保留期（EXPORT_FILE_RETENTION_HOURS）就删掉、记录改成已过期；'
    '卡住的导出记成失败；过了 EXPORT_RECORD_RETENTION_DAYS 的记录删掉'
)


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    # 开发环境的应用启动时会 `create_all`（prod 不会，见 alembic 分册），开着 dev 服务器再升级，
    # 表已经在了。同 `735d74e723c0` 的 `wf_draft`：表在就跳过，索引跟着模型一起建过了
    if not _has_table('sys_export_job'):
        _create_export_job()
    _seed()


def _create_export_job() -> None:
    op.create_table(
        'sys_export_job',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='主键 ID'),
        sa.Column('resource', backend.common.model.UniversalStr(length=64), nullable=False, comment='导出的资源'),
        sa.Column('title', backend.common.model.UniversalStr(length=128), nullable=False, comment='资源名（快照）'),
        sa.Column(
            'format', backend.common.model.UniversalStr(length=8), nullable=False, comment='文件格式（xlsx / csv）'
        ),
        sa.Column('params', backend.common.model.UniversalText(), nullable=False, comment='导出参数 JSON'),
        sa.Column('language', backend.common.model.UniversalStr(length=16), nullable=False, comment='发起时的界面语言'),
        sa.Column('created_by', sa.BigInteger(), nullable=False, comment='发起人 ID'),
        sa.Column(
            'status',
            sa.Integer(),
            nullable=False,
            comment='状态（0：排队、1：生成中、2：完成、3：失败、4：已过期）',
        ),
        sa.Column('total', sa.Integer(), nullable=False, comment='发起时按条件数出的行数'),
        sa.Column('row_count', sa.Integer(), nullable=True, comment='已写出的行数'),
        sa.Column('file_name', backend.common.model.UniversalStr(length=255), nullable=False, comment='下载文件名'),
        sa.Column('file_size', sa.BigInteger(), nullable=True, comment='文件字节数'),
        sa.Column('file_sha256', backend.common.model.UniversalStr(length=64), nullable=True, comment='文件 SHA-256'),
        sa.Column('storage_id', sa.BigInteger(), nullable=True, comment='文件所在存储'),
        sa.Column(
            'object_key', backend.common.model.UniversalStr(length=512), nullable=True, comment='文件在存储里的 key'
        ),
        sa.Column('error', backend.common.model.UniversalText(), nullable=True, comment='失败原因'),
        sa.Column(
            'task_id',
            backend.common.model.UniversalStr(length=64),
            nullable=True,
            comment='Celery 任务 ID（后台导出才有）',
        ),
        sa.Column(
            'started_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='开始生成的时间'
        ),
        sa.Column(
            'finished_time',
            backend.common.model.TimeZone(timezone=True),
            nullable=True,
            comment='结束时间（成功或失败）',
        ),
        sa.Column('expire_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='文件过期时间'),
        sa.Column('download_count', sa.Integer(), nullable=False, comment='下载次数'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='导出任务表',
    )
    op.create_index(op.f('ix_sys_export_job_id'), 'sys_export_job', ['id'], unique=True)
    op.create_index('ix_sys_export_job_owner', 'sys_export_job', ['created_by', 'created_time'], unique=False)
    op.create_index('ix_sys_export_job_expire', 'sys_export_job', ['status', 'expire_time'], unique=False)


def _seed() -> None:
    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    conn = op.get_bind()
    for menu_id, name, title, perms, sort, parent, plugin in _MENUS:
        if plugin is not None and not check_plugin_installed(plugin):
            # 插件卸载了不该插一个挂不上去的按钮（同 f0000000aimenu）
            continue
        add_menu(conn, menu_id=menu_id, name=name, title=title, perms=perms, sort=sort, parent_name=parent)

    # 每一列都显式给值：Core insert 不经过 ORM，模型上的 Python 默认值一个都不生效（同 677aa7aa0f73）
    insert_if_absent(
        conn,
        'task_scheduler',
        {'name': _SCHEDULER_NAME},
        {
            'id': _SCHEDULER_ID,
            'task': 'maintenance.purge_expired_exports',
            'args': None,
            'kwargs': None,
            'queue': None,
            'exchange': None,
            'routing_key': None,
            'start_time': None,
            'expire_time': None,
            'expire_seconds': None,
            'type': 1,
            'interval_every': None,
            'interval_period': None,
            # 保留期以小时计，所以每小时扫一次；过期文件最多多留一小时，下载早在过期那一刻就拦了
            'crontab': '20 * * * *',
            'one_off': False,
            'enabled': True,
            'total_run_count': 0,
            'last_run_time': None,
            'remark': _REMARK,
            'created_time': timezone.now(),
        },
    )


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        delete_by_key(conn, 'task_scheduler', name=_SCHEDULER_NAME)
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    op.drop_index('ix_sys_export_job_expire', table_name='sys_export_job')
    op.drop_index('ix_sys_export_job_owner', table_name='sys_export_job')
    op.drop_index(op.f('ix_sys_export_job_id'), table_name='sys_export_job')
    op.drop_table('sys_export_job')
