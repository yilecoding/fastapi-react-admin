"""sys_file 加 purged_time（回收站）+ 回收站索引，回填存量已删记录，补「清理回收站」调度（#122 第二期）

Revision ID: m0000000recycle
Revises: l0000000storage
Create Date: 2026-10-22 12:00:00

🔴 **回填不是可选项。** 这一列加进来之前，「删除」是对象和记录一起删的 —— 存量里 `deleted ≠ 0` 的行
对象早就没了。不回填的话它们全部出现在回收站里（`deleted ≠ 0 且 purged_time IS NULL`），
而且一还原就是一批点开即「文件已丢失」的记录。回填成它们的 `deleted_time`：那就是对象被删的时刻。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'm0000000recycle'
down_revision = 'l0000000storage'
branch_labels = None
depends_on = None

#: 照抄种子里那个 ID（三个方言同一套），升级上来的库和新建的库收敛
_SCHEDULER_ID = 2049629108253622323
_SCHEDULER_NAME = '清理回收站'
_REMARK = '彻底删除回收站里超过保留期的文件（保留天数是 FILE_RECYCLE_DAYS，默认 30，不在这里配）'


def upgrade() -> None:
    op.add_column(
        'sys_file',
        sa.Column(
            'purged_time',
            backend.common.model.TimeZone(timezone=True),
            nullable=True,
            comment='对象被彻底删除的时间（deleted≠0 且为空 = 在回收站里）',
        ),
    )
    op.create_index('ix_sys_file_recycle', 'sys_file', ['deleted', 'purged_time', 'deleted_time'], unique=False)

    # 存量的已删记录：对象当时就删了 → 标成已清除，不进回收站
    sys_file = sa.table(
        'sys_file',
        sa.column('deleted', sa.BigInteger()),
        sa.column('deleted_time', backend.common.model.TimeZone(timezone=True)),
        sa.column('purged_time', backend.common.model.TimeZone(timezone=True)),
    )
    op.execute(
        sys_file
        .update()
        .where(sys_file.c.deleted != 0, sys_file.c.purged_time.is_(None))
        .values(purged_time=sa.func.coalesce(sys_file.c.deleted_time, sa.func.current_timestamp()))
    )

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    # 每一列都显式给值：Core insert 不经过 ORM，模型上的 Python 默认值一个都不生效（同 677aa7aa0f73）
    insert_if_absent(
        op.get_bind(),
        'task_scheduler',
        {'name': _SCHEDULER_NAME},
        {
            'id': _SCHEDULER_ID,
            'task': 'maintenance.purge_recycled_files',
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
            'crontab': '45 3 * * *',
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
        delete_by_key(op.get_bind(), 'task_scheduler', name=_SCHEDULER_NAME)
    op.drop_index('ix_sys_file_recycle', table_name='sys_file')
    op.drop_column('sys_file', 'purged_time')
