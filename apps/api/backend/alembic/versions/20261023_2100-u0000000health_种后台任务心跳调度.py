"""种「后台任务心跳」调度 —— 补给已存在的库（#147）

Revision ID: u0000000health
Revises: s0000000session
Create Date: 2026-10-23 21:00:00

不动表结构，只补 `task_scheduler` 一行（同种子 `sql/*/init_snowflake_test_data.sql`）。
`health.heartbeat` 每 60 秒由 beat 派发、worker 执行时写心跳，`/health/status` 靠它判断 worker
是否在消费任务。不补的话升级上来的库 worker 一项永远 `missing`，和 worker 真挂了长得一样。

- **按 `task` 判存在，不按 `name`**：名字管理员能在界面上改，改过名再升级就会多插一行；
  已存在（含被软删的）就跳过、不覆盖 —— 覆盖会把管理员调过的间隔悄悄改回去
- `expire_seconds = 180`（= 判定阈值 `HEARTBEAT_MAX_AGE_SECONDS`）：排队超过阈值的心跳已经没有意义，
  worker 停了很久再起来时直接丢掉，不必把积压的几百条挨个跑一遍
"""

from alembic import op

from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'u0000000health'
down_revision = 's0000000session'
branch_labels = None
depends_on = None

#: 照抄种子里那个 ID（三个方言同一套），升级上来的库和新建的库收敛
_SCHEDULER_ID = 2049629108253622325
_TASK = 'health.heartbeat'
_REMARK = (
    '每 60 秒派一次，worker 执行时写心跳。外部监控探 /api/health/status 靠它判断 worker 是否在消费任务；'
    '停用或删除后 worker 一项会一直报 missing / stale'
)


def upgrade() -> None:
    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    # 每一列都显式给值：Core insert 不经过 ORM，模型上的 Python 默认值一个都不生效（同 677aa7aa0f73）
    insert_if_absent(
        op.get_bind(),
        'task_scheduler',
        {'task': _TASK},
        {
            'id': _SCHEDULER_ID,
            'name': '后台任务心跳',
            'args': None,
            'kwargs': None,
            'queue': None,
            'exchange': None,
            'routing_key': None,
            'start_time': None,
            'expire_time': None,
            'expire_seconds': 180,
            'type': 0,
            'interval_every': 60,
            'interval_period': 'seconds',
            'crontab': '* * * * *',
            'one_off': False,
            'enabled': True,
            'total_run_count': 0,
            'last_run_time': None,
            'remark': _REMARK,
            'created_time': timezone.now(),
        },
    )


def downgrade() -> None:
    # 只删这条迁移插的那一行（按 id），不按 task 批量删
    if seeded_pk_mode():
        delete_by_key(op.get_bind(), 'task_scheduler', id=_SCHEDULER_ID)
