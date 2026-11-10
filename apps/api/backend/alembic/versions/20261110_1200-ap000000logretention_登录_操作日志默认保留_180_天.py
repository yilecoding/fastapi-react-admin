"""登录 / 操作日志默认保留天数 30 → 180（网络安全法的六个月下限）

Revision ID: ap000000logretention
Revises: ao000000loginevent
Create Date: 2026-11-10 12:00:00

issue #261。不动表结构，只改种子里那条「清理历史日志」调度（`maintenance.prune_logs`）的参数，
同种子 `sql/*/init_snowflake_test_data.sql`。不补的话只有新装的库是 180 天，已经在跑的库还是 30 天。

🔴 **只改「还是种子原值」的那一行**：按种子 ID 找、参数解析出来还是 `{"days": 30}` 才改。
管理员自己调过天数的（哪怕调得比 180 短）不动 —— 调度参数是部署方的配置，悄悄改掉等于替人做合规决定
（根 `CLAUDE.md`「1.0 起的兼容约定」）。参数按 JSON 解析后比，不按字符串比：界面上保存过一次，
空格可能就变了，但值还是种子那个 30。备注同理，还是种子原文才换。

降级不改回去：180 天比 30 天留得多，旧代码照样认 `days` 参数；而且分不清「这条迁移改的」
和「管理员自己就设的 180」，改回去可能把后者也改成 30。
"""

import json

import sqlalchemy as sa

from alembic import op
from sqlalchemy.engine import Connection

from backend.utils.data_migration import seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'ap000000logretention'
down_revision = 'ao000000loginevent'
branch_labels = None
depends_on = None

#: 种子里那一行（三个方言同一个 ID）
_SCHEDULER_ID = 2049629108253622320
_TASK = 'maintenance.prune_logs'
_OLD_KWARGS = {'days': 30}
#: 和 `maintenance/tasks.py: LOG_RETENTION_DAYS`、种子 SQL 同一个数
_NEW_KWARGS = '{"days": 180}'
_OLD_REMARK = '保留 30 天。日志表是全库长得最快的表，不清理会一直涨'
_NEW_REMARK = '保留 180 天：网络安全法要求网络日志留存不少于六个月。日志表是全库长得最快的表，不清理会一直涨'


def bump_seed_retention(conn: Connection) -> bool:
    """种子那一行的参数还是 `{"days": 30}` 时改成 180，返回是否改了（测试直接调它）"""
    t = sa.table(
        'task_scheduler',
        sa.column('id'),
        sa.column('task'),
        sa.column('kwargs'),
        sa.column('remark'),
        sa.column('updated_time'),
    )
    row = conn.execute(sa.select(t.c.kwargs, t.c.remark).where(t.c.id == _SCHEDULER_ID, t.c.task == _TASK)).first()
    if row is None or not row.kwargs:
        return False
    try:
        current = json.loads(row.kwargs)
    except ValueError:
        return False
    if current != _OLD_KWARGS:
        return False
    values = {'kwargs': _NEW_KWARGS, 'updated_time': timezone.now()}
    if row.remark == _OLD_REMARK:
        values['remark'] = _NEW_REMARK
    conn.execute(sa.update(t).where(t.c.id == _SCHEDULER_ID).values(values))
    return True


def upgrade() -> None:
    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    bump_seed_retention(op.get_bind())


def downgrade() -> None:
    # 刻意不改回去，理由见文件头
    pass
