"""公告二期：sys_notice 加弹窗 / 必须确认 / 定时发布 / 登录页可见 · 受众表 sys_notification_audience · 收件箱对时调度

Revision ID: ag000000noticephase2
Revises: af000000noticereach
Create Date: 2026-10-30 20:00:00

issue #190。

- `popup` / `require_ack` / `public` 是 NOT NULL：先带 server_default 回填存量行，再去掉 DEFAULT
  （模型侧是 Python 级默认值，同 `af000000noticereach`）。🔴 SQL Server 的默认值是**具名约束**，
  `alter_column(server_default=None)` 要真删得掉，否则 `create_all` 建的库和迁移升上来的库不一致
- `public` 在 SQL Server 上是保留字：alembic 生成的 DDL 自己加方括号，手写的种子 SQL 要写 `[public]`
- `sys_notification_audience` 是迁移建的新表：雪花主键显式 `autoincrement=False`，不然 SQL Server 上建成 IDENTITY、
  一行都插不进去（alembic 分册）
- 数据部分：`task_scheduler` 补一行 `notice.sync_inbox`（每 60 秒，定时发布到点就发、过期就撤；同 `u0000000health`）。
  按 `task` 判存在，已存在（含被软删的）就跳过、不覆盖 —— 覆盖会把管理员调过的间隔悄悄改回去。
  种子（`plugin/notice/sql/*/init_snowflake.sql`）同一份 ID，`seed_manifest.json` 跟着更新

存量公告：三个开关回填 false、`publish_time` 为空（= 早就发布了），行为和升级前一样；没有受众行 = 全员，也和升级前一样。

降级：有发布范围的、还没到发布时间的公告先改成隐藏、收件箱行撤掉 —— 旧代码不认这两样，不处理就是全员立刻可见。
"""

import sqlalchemy as sa

from alembic import context, op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'ag000000noticephase2'
down_revision = 'af000000noticereach'
branch_labels = None
depends_on = None

#: 照抄种子里那个 ID（三个方言同一套），升级上来的库和新建的库收敛
_SCHEDULER_ID = 2250000000000000101
_TASK = 'notice.sync_inbox'
_REMARK = (
    '每 60 秒对一次公告的收件箱：定时发布到点的发出去、过期的撤回。'
    '停用后定时发布的公告到点也不会出现，过期公告的消息会一直挂在铃铛里'
)

#: (列, 注释)
_FLAGS = (
    ('popup', '登录后弹窗'),
    ('require_ack', '必须点「我已阅读」（只在登录后弹窗时有意义）'),
    ('public', '登录页可见（不登录也能看；不能有发布范围）'),
)


def upgrade() -> None:
    ustr = backend.common.model.UniversalStr

    op.create_table(
        'sys_notification_audience',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column(
            'source',
            ustr(length=64),
            nullable=False,
            comment='来源业务对象（如 notice:123，同 sys_notification.source）',
        ),
        sa.Column(
            'kind', ustr(length=16), nullable=False, comment='受众类型（dept：部门含下级、role：角色、user：用户）'
        ),
        sa.Column('target_id', sa.BigInteger(), nullable=False, comment='部门 / 角色 / 用户 ID'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('source', 'kind', 'target_id', name='uq_notification_audience'),
        comment='通知受众表',
    )
    op.create_index(op.f('ix_sys_notification_audience_id'), 'sys_notification_audience', ['id'], unique=True)
    op.create_index(op.f('ix_sys_notification_audience_source'), 'sys_notification_audience', ['source'], unique=False)

    for column, comment in _FLAGS:
        op.add_column(
            'sys_notice',
            sa.Column(column, sa.Boolean(), nullable=False, server_default=sa.false(), comment=comment),
        )
        op.alter_column('sys_notice', column, server_default=None)
    op.add_column(
        'sys_notice',
        sa.Column(
            'publish_time',
            backend.common.model.TimeZone(timezone=True),
            nullable=True,
            comment='定时发布时间（为空立即发布；到点之前读者看不到、不进收件箱）',
        ),
    )

    if seeded_pk_mode() and check_plugin_installed('notice'):
        # 每一列都显式给值：Core insert 不经过 ORM，模型上的 Python 默认值一个都不生效（同 677aa7aa0f73）
        insert_if_absent(
            op.get_bind(),
            'task_scheduler',
            {'task': _TASK},
            {
                'id': _SCHEDULER_ID,
                'name': '公告收件箱对时',
                'args': None,
                'kwargs': None,
                'queue': None,
                'exchange': None,
                'routing_key': None,
                'start_time': None,
                'expire_time': None,
                # 排队超过一个周期的就不用跑了，下一拍会再扫一遍
                'expire_seconds': 60,
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


def _hide_what_would_leak() -> None:
    """降级会丢掉「发给谁」和「什么时候发」：有发布范围的、还没到发布时间的公告，降级之后在旧代码里就是**全员立刻可见**。
    先把它们改成隐藏、收件箱行撤掉（逻辑删除），宁可要人重新发，也不能悄悄发给不该看的人"""
    bind = op.get_bind()
    tz = backend.common.model.TimeZone(timezone=True)
    notice = sa.table(
        'sys_notice', sa.column('id', sa.BigInteger), sa.column('status', sa.Integer), sa.column('publish_time', tz)
    )
    audience = sa.table('sys_notification_audience', sa.column('source', sa.String))
    inbox = sa.table(
        'sys_notification',
        sa.column('id', sa.BigInteger),
        sa.column('source', sa.String),
        sa.column('deleted', sa.BigInteger),
        sa.column('deleted_time', tz),
    )
    now = timezone.now()
    ids: set[int] = set()
    for (source,) in bind.execute(sa.select(audience.c.source).distinct()).all():
        kind, _, raw = (source or '').partition(':')
        if kind == 'notice' and raw.isdigit():
            ids.add(int(raw))
    ids.update(bind.execute(sa.select(notice.c.id).where(notice.c.publish_time > now)).scalars().all())
    ordered = sorted(ids)
    # 分批：SQL Server 一条语句最多 2100 个参数
    for i in range(0, len(ordered), 500):
        chunk = ordered[i : i + 500]
        bind.execute(sa.update(notice).where(notice.c.id.in_(chunk)).values(status=0))
        bind.execute(
            sa
            .update(inbox)
            .where(inbox.c.source.in_([f'notice:{pk}' for pk in chunk]), inbox.c.deleted == 0)
            .values(deleted=inbox.c.id, deleted_time=now)
        )


def downgrade() -> None:
    # 离线 `--sql` 模式没有真连接（`test_migrations_compile_offline_for_every_supported_dialect`）
    if not context.is_offline_mode():
        _hide_what_would_leak()
    # 只删这条迁移插的那一行（按 id），不按 task 批量删
    if seeded_pk_mode():
        delete_by_key(op.get_bind(), 'task_scheduler', id=_SCHEDULER_ID)
    op.drop_column('sys_notice', 'publish_time')
    for column, _comment in reversed(_FLAGS):
        op.drop_column('sys_notice', column)
    op.drop_index(op.f('ix_sys_notification_audience_source'), table_name='sys_notification_audience')
    op.drop_index(op.f('ix_sys_notification_audience_id'), table_name='sys_notification_audience')
    op.drop_table('sys_notification_audience')
