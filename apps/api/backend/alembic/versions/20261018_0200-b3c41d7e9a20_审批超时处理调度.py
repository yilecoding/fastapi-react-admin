"""审批超时处理调度（每 5 分钟）

种子在 `plugin/workflow/sql/*/init_snowflake.sql`（新库由 `fba init` 灌），这条让**已经在跑的库**也有这一行 ——
种子只在建库时执行一次（同 `677aa7aa0f73` 补「每日问候」那条）。没有这一行的话超时配置照样能保存，
只是 beat 从来不排这个任务：界面上配了「24 小时自动同意」，单子永远不会被自动处理。

Revision ID: b3c41d7e9a20
Revises: a7d8fbe59942
Create Date: 2026-10-18 02:00:00.000000+08:00

"""

from alembic import op

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'b3c41d7e9a20'
down_revision = 'a7d8fbe59942'
branch_labels = None
depends_on = None

_ID = 2049629108266205230
_NAME = '审批超时处理'


def upgrade() -> None:
    if not seeded_pk_mode() or not check_plugin_installed('workflow'):
        return
    insert_if_absent(
        op.get_bind(),
        'task_scheduler',
        {'name': _NAME},
        {
            'id': _ID,
            'task': 'workflow.handle_timeouts',
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
            'crontab': '*/5 * * * *',
            'one_off': False,
            'enabled': True,
            'total_run_count': 0,
            'last_run_time': None,
            'remark': '每 5 分钟扫一遍审批待办：节点配了超时的，按配置提醒 / 自动同意 / 自动驳回',
            'created_time': timezone.now(),
        },
    )


def downgrade() -> None:
    if not seeded_pk_mode():
        return
    delete_by_key(op.get_bind(), 'task_scheduler', name=_NAME)
