"""补齐每日问候调度 + 记下清单基线会洗白既有缺口

Revision ID: 677aa7aa0f73
Revises: 33ffb491b69f
Create Date: 2026-08-31 15:18:00.000000+08:00

issue #86 点了两个缺口，`33ffb491b69f` 只补了一个。这条补另一个：
`256beae`（PR #83）往种子里加的「每日问候」调度从没进生产库 ——
功能代码部署了，`task_scheduler` 里没有这一行，**beat 从来没排过它**。

🔴 **顺带记一个我自己造的洞。** `33ffb491b69f` 引进的清单守卫
（`test_seed_files_have_a_matching_data_migration_decision`）只能发现
「清单建立**之后**」的种子改动。而那份清单是在 #83 已经落地之后算的 ——
于是 #83 那次没补迁移的改动被基线**一次性洗白**，守卫此后再也看不见它，
而且是绿的。所以：

  **`seed:manifest --write` 之前，必须先确认当前种子与迁移链是一致的。**
  在一个「已知落后」的状态上建基线，等于把那个缺口永久藏起来。

这条经验写进了 `apps/api/AGENTS.md` 和 `backend/scripts/seed_manifest.py`。
"""

from alembic import op

from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = '677aa7aa0f73'
down_revision = '33ffb491b69f'
branch_labels = None
depends_on = None

#: 照抄种子里那个 ID —— 三个方言的 `task_scheduler` 用的是同一套，
#: 抄过来能让「升级上来的库」和「`fba init` 新建的库」收敛
_SCHEDULER_ID = 2049629108253622322
_SCHEDULER_NAME = '每日问候'
_REMARK = '每天 9:00 给全员发一条随机问候语，顺带验收消息中心链路（落库/未读数/socket 推送/前端红点）是否通畅'


def upgrade() -> None:
    if not seeded_pk_mode():
        return

    # ⚠️ 每一列都显式给值，**不要指望模型上的 default**：迁移走的是 Core insert，
    # 不经过 ORM，`crontab='* * * * *'` / `type=1` / `enabled=True` 这些 Python 侧
    # 默认值一个都不会生效，而 `crontab` / `type` / `total_run_count` 都是 NOT NULL。
    #
    # ⚠️ `one_off` / `enabled` 传 Python bool，让 SQLAlchemy 按方言渲染
    # （mssql/mysql 是 0/1、postgresql 是 false/true）。写死 0/1 会在 postgresql 上
    # 报类型错 —— 这正是 `apps/api/AGENTS.md` 里「postgres 那份种子务必用 true/false」
    # 那条坑的迁移版本。
    insert_if_absent(
        op.get_bind(),
        'task_scheduler',
        # `task_scheduler` 上有 `(name, deleted)` 唯一约束，name 就是它的业务键
        {'name': _SCHEDULER_NAME},
        {
            'id': _SCHEDULER_ID,
            'task': 'notification.send_daily_greeting',
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
            'crontab': '0 9 * * *',
            'one_off': False,
            'enabled': True,
            'total_run_count': 0,
            'last_run_time': None,
            'remark': _REMARK,
            'created_time': timezone.now(),
        },
    )


def downgrade() -> None:
    if not seeded_pk_mode():
        return
    delete_by_key(op.get_bind(), 'task_scheduler', name=_SCHEDULER_NAME)
