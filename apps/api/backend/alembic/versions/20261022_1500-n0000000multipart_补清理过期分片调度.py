"""补「清理过期分片」调度（#122 第三期）

Revision ID: n0000000multipart
Revises: m0000000recycle
Create Date: 2026-10-22 15:00:00

分片上传本身不动表结构（会话在 Redis，分片在存储里），这一条只补调度：会话过期后留下的分片
由 `maintenance.purge_stale_multipart` 清掉。不补的话升级上来的库没有这条调度，分片一直堆在存储里。
"""

from alembic import op

from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'n0000000multipart'
down_revision = 'm0000000recycle'
branch_labels = None
depends_on = None

#: 照抄种子里那个 ID（三个方言同一套），升级上来的库和新建的库收敛
_SCHEDULER_ID = 2049629108253622324
_SCHEDULER_NAME = '清理过期分片'
_REMARK = '清掉过期分片上传（会话在 Redis 里 FILE_MULTIPART_EXPIRE_SECONDS 没动静就过期）留在存储里的分片'


def upgrade() -> None:
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
            'task': 'maintenance.purge_stale_multipart',
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
            'crontab': '0 4 * * *',
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
