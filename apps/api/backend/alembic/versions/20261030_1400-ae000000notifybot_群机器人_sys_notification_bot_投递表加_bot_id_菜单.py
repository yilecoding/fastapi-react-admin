"""群机器人：sys_notification_bot · 投递表 user_id 改可空、加 bot_id · 菜单

Revision ID: ae000000notifybot
Revises: ad000000usermfa
Create Date: 2026-10-30 14:00:00

issue #166 二期。群机器人的投递发给一个群、不是一个人，所以投递表的 `user_id` 要能为空、另加 `bot_id`。

🔴 SQL Server 上改 `user_id` 的可空性，**两个方向不对称**：NOT NULL → NULL 放行；NULL → NOT NULL 被它上面的索引挡住
（`Msg 5074 The index ... is dependent on column`）。所以只有 downgrade 要先删索引、改完再建
（2026-10-30 实测：第一版 downgrade 没删，在 SQL Server 上当场 5074）。
MySQL 的 `MODIFY` 会丢掉没写上的注释和 NOT NULL（alembic 分册），所以 `comment` / `existing_nullable` 都显式带上。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'ae000000notifybot'
down_revision = 'ad000000usermfa'
branch_labels = None
depends_on = None

#: 和 `plugin/notification/sql/*/init_snowflake.sql` 同一套 ID。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (
        2240000000000000008,
        'NotifyBot',
        '群机器人',
        '/notify/bot',
        'mdi:message-arrow-right-outline',
        1,
        None,
        3,
        1,
        'NotifyCenter',
    ),
    (2240000000000000009, 'QueryNotifyBot', '查询', None, None, 2, 'sys:notification:bot:list', 0, 0, 'NotifyBot'),
    (2240000000000000010, 'AddNotifyBot', '新增', None, None, 2, 'sys:notification:bot:add', 1, 0, 'NotifyBot'),
    (2240000000000000011, 'EditNotifyBot', '修改', None, None, 2, 'sys:notification:bot:edit', 2, 0, 'NotifyBot'),
    (2240000000000000012, 'DeleteNotifyBot', '删除', None, None, 2, 'sys:notification:bot:del', 3, 0, 'NotifyBot'),
    (2240000000000000013, 'TestNotifyBot', '发测试消息', None, None, 2, 'sys:notification:bot:test', 4, 0, 'NotifyBot'),
]

_USER_ID_OLD_COMMENT = '接收人 ID'
_USER_ID_NEW_COMMENT = '接收人 ID（群机器人的投递为空）'
#: (列, 长度, 可空, 旧注释, 新注释)。🔴 `existing_nullable` 要给：MySQL 的 MODIFY 不写 NOT NULL 就变成可空
_COMMENTS = (
    ('channel', 16, False, '渠道（email / sms）', '渠道（email / sms / bot）'),
    (
        'address',
        256,
        True,
        '发送时的地址快照（邮箱 / 手机号；列表接口掩码）',
        '发送时的地址快照（邮箱 / 手机号 / 机器人名称；列表接口掩码）',
    ),
)


def _set_comments(*, forward: bool) -> None:
    # 给 existing_comment：alembic 在 SQL Server 上才会走 sp_updateextendedproperty，
    # 否则是 add、撞「已存在」（alembic 分册）
    for column, length, nullable, old, new in _COMMENTS:
        op.alter_column(
            'sys_notification_delivery',
            column,
            existing_type=backend.common.model.UniversalStr(length=length),
            existing_nullable=nullable,
            comment=new if forward else old,
            existing_comment=old if forward else new,
        )


def _set_user_id_nullable(*, nullable: bool, comment: str, old_comment: str) -> None:
    if not nullable:
        op.drop_index(op.f('ix_sys_notification_delivery_user_id'), table_name='sys_notification_delivery')
    op.alter_column(
        'sys_notification_delivery',
        'user_id',
        existing_type=sa.BigInteger(),
        nullable=nullable,
        comment=comment,
        existing_comment=old_comment,
    )
    if not nullable:
        op.create_index(
            op.f('ix_sys_notification_delivery_user_id'), 'sys_notification_delivery', ['user_id'], unique=False
        )


def upgrade() -> None:
    ustr = backend.common.model.UniversalStr
    utext = backend.common.model.UniversalText
    tz = backend.common.model.TimeZone

    op.create_table(
        'sys_notification_bot',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('name', ustr(length=64), nullable=False, comment='名称（投递记录里显示的就是它）'),
        sa.Column('platform', ustr(length=16), nullable=False, comment='平台（feishu / dingtalk / wecom）'),
        sa.Column('webhook_cipher', utext(), nullable=False, comment='Webhook 地址密文（AES；地址本身就是凭据）'),
        sa.Column('webhook_hint', ustr(length=128), nullable=False, comment='Webhook 地址掩码（只用于辨认）'),
        sa.Column('kinds', utext(), nullable=False, comment='订阅的通知类型码 JSON 数组'),
        sa.Column(
            'secret_cipher', utext(), nullable=True, comment='加签密钥密文（飞书 / 钉钉的「签名校验」；没开就为空）'
        ),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0：停用、1：正常）'),
        sa.Column('remark', ustr(length=256), nullable=True, comment='备注'),
        sa.Column('last_sent_time', tz(timezone=True), nullable=True, comment='最近一次发送成功的时间'),
        sa.Column('last_error', utext(), nullable=True, comment='最近一次失败的原因（成功后清空）'),
        sa.Column('created_by', sa.BigInteger(), nullable=True, comment='创建者 ID'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', tz(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='通知群机器人表',
    )
    op.create_index(op.f('ix_sys_notification_bot_id'), 'sys_notification_bot', ['id'], unique=True)

    _set_user_id_nullable(nullable=True, comment=_USER_ID_NEW_COMMENT, old_comment=_USER_ID_OLD_COMMENT)
    _set_comments(forward=True)
    op.add_column(
        'sys_notification_delivery',
        sa.Column('bot_id', sa.BigInteger(), nullable=True, comment='群机器人 ID（只有群机器人的投递有值）'),
    )
    op.create_index(op.f('ix_sys_notification_delivery_bot_id'), 'sys_notification_delivery', ['bot_id'], unique=False)

    if seeded_pk_mode() and check_plugin_installed('notification'):
        conn = op.get_bind()
        for menu_id, name, title, path, icon, menu_type, perms, sort, display, parent in _MENUS:
            add_menu(
                conn,
                menu_id=menu_id,
                name=name,
                title=title,
                path=path,
                perms=perms,
                icon=icon,
                menu_type=menu_type,
                sort=sort,
                display=display,
                parent_name=parent,
            )


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    # 群机器人的投递没有接收人：改回非空之前先删掉，否则 ALTER 撞上 NULL 当场失败
    op.execute(sa.text('DELETE FROM sys_notification_delivery WHERE user_id IS NULL'))
    op.drop_index(op.f('ix_sys_notification_delivery_bot_id'), table_name='sys_notification_delivery')
    op.drop_column('sys_notification_delivery', 'bot_id')
    _set_comments(forward=False)
    _set_user_id_nullable(nullable=False, comment=_USER_ID_OLD_COMMENT, old_comment=_USER_ID_NEW_COMMENT)
    op.drop_index(op.f('ix_sys_notification_bot_id'), table_name='sys_notification_bot')
    op.drop_table('sys_notification_bot')
