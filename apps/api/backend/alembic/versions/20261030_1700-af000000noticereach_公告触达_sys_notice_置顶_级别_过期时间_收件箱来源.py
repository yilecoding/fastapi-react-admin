"""公告触达：sys_notice 加置顶 / 级别 / 过期时间 · sys_notification 加来源 · 旧公告的收件箱行认领来源

Revision ID: af000000noticereach
Revises: ae000000notifybot
Create Date: 2026-10-30 17:00:00

issue #186。`pinned` / `level` 是 NOT NULL：先带 server_default 回填存量行，再去掉 DEFAULT（模型侧是 Python 级默认值，
同 `735d74e723c0`）。

数据部分：#186 之前发的公告，收件箱那一行没有 `source`，`link` 指着管理页 `/plugins/notice`（普通用户点进去 403）。
按标题认领：一行广播只在**恰好一条**没删的公告同名时改，对不上的不动 —— 猜错了等于把 A 公告的已读状态挂到 B 上。
认不上的那几行照旧指着管理页，前端按 `source` 为空当普通通知处理。

种子同时改了（`seed_manifest.json` 跟着更新）：公告的 INSERT 补上两列；pg / mysql 的演示公告换成和 SQL Server
同一份内容；收件箱演示行带上 `source` 和新链接。**已有的库不跟**：演示内容是可以被人改过的数据（alembic 分册
「不要重新灌整份种子」），需要跟上的只有那一行收件箱，上面的认领已经覆盖了标题对得上的情形。
"""

import sqlalchemy as sa

from alembic import context, op

import backend.common.model

from backend.plugin.core import check_plugin_installed

# revision identifiers, used by Alembic.
revision = 'af000000noticereach'
down_revision = 'ae000000notifybot'
branch_labels = None
depends_on = None

_LEGACY_LINK = '/plugins/notice'


def _claim_legacy_rows() -> None:
    bind = op.get_bind()
    notice = sa.table(
        'sys_notice',
        sa.column('id', sa.BigInteger),
        sa.column('title', sa.String),
        sa.column('deleted', sa.BigInteger),
    )
    inbox = sa.table(
        'sys_notification',
        sa.column('id', sa.BigInteger),
        sa.column('title', sa.String),
        sa.column('link', sa.String),
        sa.column('source', sa.String),
        sa.column('recipient_id', sa.BigInteger),
        sa.column('deleted', sa.BigInteger),
    )
    by_title: dict[str, list[int]] = {}
    for pk, title in bind.execute(sa.select(notice.c.id, notice.c.title).where(notice.c.deleted == 0)).all():
        by_title.setdefault(title, []).append(pk)
    rows = bind.execute(
        sa.select(inbox.c.id, inbox.c.title).where(
            inbox.c.link == _LEGACY_LINK,
            inbox.c.source.is_(None),
            inbox.c.recipient_id.is_(None),
            inbox.c.deleted == 0,
        )
    ).all()
    for row_id, title in rows:
        matches = by_title.get(title, [])
        if len(matches) != 1:
            continue
        bind.execute(
            sa
            .update(inbox)
            .where(inbox.c.id == row_id)
            .values(source=f'notice:{matches[0]}', link=f'/notification?notice={matches[0]}')
        )


def upgrade() -> None:
    op.add_column(
        'sys_notice',
        sa.Column('pinned', sa.Boolean(), nullable=False, server_default=sa.false(), comment='是否置顶'),
    )
    op.alter_column('sys_notice', 'pinned', server_default=None)
    op.add_column(
        'sys_notice',
        sa.Column(
            'level', sa.Integer(), nullable=False, server_default='0', comment='级别（0：普通、1：重要、2：紧急）'
        ),
    )
    op.alter_column('sys_notice', 'level', server_default=None)
    op.add_column(
        'sys_notice',
        sa.Column(
            'expire_time',
            backend.common.model.TimeZone(timezone=True),
            nullable=True,
            comment='过期时间（为空不过期；过期后读者看不到，管理页照常可见）',
        ),
    )
    op.add_column(
        'sys_notification',
        sa.Column(
            'source',
            backend.common.model.UniversalStr(length=64),
            nullable=True,
            comment='来源业务对象（如 notice:123；为空表示没有）',
        ),
    )
    op.create_index(op.f('ix_sys_notification_source'), 'sys_notification', ['source'], unique=False)

    # 离线 `--sql` 模式没有真连接（`test_migrations_compile_offline_for_every_supported_dialect`）
    if not context.is_offline_mode() and check_plugin_installed('notice'):
        _claim_legacy_rows()


def downgrade() -> None:
    # 认领过的行把链接改回管理页：降级后的代码不认 `/notification?notice=`（消息中心不会就地打开那一条）
    if not context.is_offline_mode():
        inbox = sa.table('sys_notification', sa.column('link', sa.String), sa.column('source', sa.String))
        op.get_bind().execute(sa.update(inbox).where(inbox.c.source.like('notice:%')).values(link=_LEGACY_LINK))
    op.drop_index(op.f('ix_sys_notification_source'), table_name='sys_notification')
    op.drop_column('sys_notification', 'source')
    op.drop_column('sys_notice', 'expire_time')
    op.drop_column('sys_notice', 'level')
    op.drop_column('sys_notice', 'pinned')
