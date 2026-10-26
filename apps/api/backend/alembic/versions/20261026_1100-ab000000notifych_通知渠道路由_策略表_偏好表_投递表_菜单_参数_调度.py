"""通知渠道路由：策略表 · 偏好表 · 投递表，补齐已存在库缺的菜单 / 参数配置组 / 投递调度

Revision ID: ab000000notifych
Revises: aa000000userphone
Create Date: 2026-10-26 11:00:00

issue #166。三张表 + 7 条菜单 + 「通知推送」参数组 4 行 + 投递调度 1 行放在一条里：它们一起才构成「功能可用」。
只建表不补调度，表现是**投递行一直停在「待发」**（提交后那一脚踢醒的只有在跑的 worker，安全网没有），
和 `u0000000health` 记过的「功能部署了、从来没跑过」同一个形状。

🔴 手写的建表要自己写 `autoincrement=False`：autogenerate 渲染不出模型侧的 Python 默认值，
SQL Server 上会把雪花主键建成 IDENTITY，那张表在生产里一行都写不进去（alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'ab000000notifych'
down_revision = 'aa000000userphone'
branch_labels = None
depends_on = None

#: 和 `plugin/notification/sql/*/init_snowflake.sql` 同一套 ID，升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2240000000000000001, 'NotifyCenter', '消息推送', '/notify', 'mdi:bell-cog-outline', 0, None, 11, 1, None),
    (
        2240000000000000002,
        'NotifyPolicy',
        '通知策略',
        '/notify/policy',
        'mdi:tune-variant',
        1,
        None,
        1,
        1,
        'NotifyCenter',
    ),
    (
        2240000000000000003,
        'NotifyDelivery',
        '投递记录',
        '/notify/delivery',
        'mdi:send-check-outline',
        1,
        None,
        2,
        1,
        'NotifyCenter',
    ),
    (
        2240000000000000004,
        'QueryNotifyPolicy',
        '查询',
        None,
        None,
        2,
        'sys:notification:policy:list',
        0,
        0,
        'NotifyPolicy',
    ),
    (
        2240000000000000005,
        'EditNotifyPolicy',
        '修改',
        None,
        None,
        2,
        'sys:notification:policy:edit',
        1,
        0,
        'NotifyPolicy',
    ),
    (
        2240000000000000006,
        'QueryNotifyDelivery',
        '查询',
        None,
        None,
        2,
        'sys:notification:delivery:list',
        0,
        0,
        'NotifyDelivery',
    ),
    (
        2240000000000000007,
        'ResendNotifyDelivery',
        '重发',
        None,
        None,
        2,
        'sys:notification:delivery:resend',
        1,
        0,
        'NotifyDelivery',
    ),
]

#: 照抄 `plugin/config/sql/*/init_snowflake.sql` 里那几个 ID（三个方言同一套）
_CONFIG_ROWS = (
    (2224875016875409424, '状态', 'NOTIFICATION_CONFIG_STATUS', '1', None),
    (
        2224875016875409425,
        '外部渠道总开关',
        'NOTIFICATION_EXTERNAL_ENABLED',
        'true',
        '关掉后只写站内通知，邮件 / 短信一条都不发（已经在排队的照常发完）',
    ),
    (2224875016875409426, '失败重试次数', 'NOTIFICATION_RETRY_MAX', '4', '不含第一次；结果未知的不重试'),
    (
        2224875016875409427,
        '投递记录保留（天）',
        'NOTIFICATION_DELIVERY_RETENTION_DAYS',
        '30',
        '每天凌晨的日志清理一起删',
    ),
)

_SCHEDULER_ID = 2240000000000000101
_TASK = 'notification.deliver_pending'
_REMARK = (
    '每 15 秒把到点的通知邮件 / 短信发出去（安全网：写了投递的事务提交后也会立刻踢一次）。'
    '停用后投递行会一直停在「待发」'
)


def upgrade() -> None:
    ustr = backend.common.model.UniversalStr
    utext = backend.common.model.UniversalText
    tz = backend.common.model.TimeZone

    op.create_table(
        'sys_notification_policy',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('kind', ustr(length=64), nullable=False, comment='通知类型码'),
        sa.Column('channel', ustr(length=16), nullable=False, comment='渠道（inapp / email / sms）'),
        sa.Column(
            'mode',
            ustr(length=16),
            nullable=False,
            comment='策略（off / default_on / default_off / forced）；没有行 = 用注册表的默认值',
        ),
        sa.Column('updated_by', sa.BigInteger(), nullable=True, comment='最后修改人 ID'),
        sa.Column('updated_time', tz(timezone=True), nullable=False, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('kind', 'channel', name='uq_notification_policy'),
        comment='通知渠道系统策略表',
    )
    op.create_index(op.f('ix_sys_notification_policy_id'), 'sys_notification_policy', ['id'], unique=True)

    op.create_table(
        'sys_notification_pref',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('user_id', sa.BigInteger(), nullable=False, comment='用户 ID'),
        sa.Column('kind', ustr(length=64), nullable=False, comment='通知类型码'),
        sa.Column('channel', ustr(length=16), nullable=False, comment='渠道'),
        sa.Column(
            'enabled',
            sa.Boolean(),
            nullable=False,
            comment='是否接收（只对策略为 default_on / default_off 的格子有意义）',
        ),
        sa.Column('updated_time', tz(timezone=True), nullable=False, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'kind', 'channel', name='uq_notification_pref'),
        comment='通知渠道个人偏好表',
    )
    op.create_index(op.f('ix_sys_notification_pref_id'), 'sys_notification_pref', ['id'], unique=True)
    op.create_index(op.f('ix_sys_notification_pref_user_id'), 'sys_notification_pref', ['user_id'], unique=False)

    op.create_table(
        'sys_notification_delivery',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('notification_id', sa.BigInteger(), nullable=True, comment='站内通知 ID（没有站内行时为空）'),
        sa.Column('user_id', sa.BigInteger(), nullable=False, comment='接收人 ID'),
        sa.Column('kind', ustr(length=64), nullable=False, comment='通知类型码（冗余，类型删了也读得懂）'),
        sa.Column('channel', ustr(length=16), nullable=False, comment='渠道（email / sms）'),
        sa.Column(
            'address', ustr(length=256), nullable=True, comment='发送时的地址快照（邮箱 / 手机号；列表接口掩码）'
        ),
        sa.Column('title', ustr(length=128), nullable=False, comment='标题快照'),
        sa.Column('content', utext(), nullable=False, comment='正文快照'),
        sa.Column('link', ustr(length=256), nullable=True, comment='前端路由（邮件里拼成绝对地址）'),
        sa.Column(
            'status',
            ustr(length=16),
            nullable=False,
            comment='状态（pending / sending / sent / failed / exhausted / skipped / unknown）',
        ),
        sa.Column(
            'reason',
            ustr(length=32),
            nullable=True,
            comment='没发 / 失败的分类（no_address / plugin_missing / permanent …）',
        ),
        sa.Column('attempts', sa.Integer(), nullable=False, comment='已尝试次数'),
        sa.Column('next_attempt_time', tz(timezone=True), nullable=True, comment='下一次尝试的时间（不会再试时为空）'),
        sa.Column('last_error', utext(), nullable=True, comment='最近一次的错误原文'),
        sa.Column('provider_ref', ustr(length=128), nullable=True, comment='渠道侧的流水号（短信日志 ID 等）'),
        sa.Column('duration_ms', sa.Integer(), nullable=True, comment='最近一次尝试的耗时（毫秒）'),
        sa.Column('sent_time', tz(timezone=True), nullable=True, comment='发送成功的时间'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', tz(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='通知外部渠道投递记录表',
    )
    for name in ('id', 'notification_id', 'user_id', 'kind', 'channel', 'created_time'):
        op.create_index(
            op.f(f'ix_sys_notification_delivery_{name}'), 'sys_notification_delivery', [name], unique=name == 'id'
        )
    op.create_index(
        'ix_sys_notification_delivery_due', 'sys_notification_delivery', ['status', 'next_attempt_time'], unique=False
    )

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    conn = op.get_bind()
    if check_plugin_installed('notification'):
        # 插件卸载了不该插一个点进去 404 的菜单（同 f0000000aimenu）。顺序不能乱：目录先于子项
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
        # 按 `task` 判存在，不按 `name`：名字管理员能在界面上改（同 u0000000health）。
        # 每一列显式给值：Core insert 不经过 ORM
        insert_if_absent(
            conn,
            'task_scheduler',
            {'task': _TASK},
            {
                'id': _SCHEDULER_ID,
                'name': '通知投递',
                'args': None,
                'kwargs': None,
                'queue': None,
                'exchange': None,
                'routing_key': None,
                'start_time': None,
                'expire_time': None,
                # 排队超过 60 秒的就丢掉：worker 停了很久再起来时，一条就把积压的全发完，不用挨个跑几百条空任务
                'expire_seconds': 60,
                'type': 0,
                'interval_every': 15,
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
    if check_plugin_installed('config'):
        for pk, name, key, value, remark in _CONFIG_ROWS:
            # 按 `key` 判存在：有人已经在界面上手工加过同名键，就不再插第二条、也不覆盖他填的值
            insert_if_absent(
                conn,
                'sys_config',
                {'key': key},
                {
                    'id': pk,
                    'name': name,
                    'type': 'NOTIFICATION',
                    'value': value,
                    'is_frontend': False,
                    'remark': remark,
                    'created_time': timezone.now(),
                    'updated_time': None,
                },
            )


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        for pk, _, key, _, _ in _CONFIG_ROWS:
            delete_by_key(conn, 'sys_config', id=pk, key=key)
        delete_by_key(conn, 'task_scheduler', id=_SCHEDULER_ID)
        # 倒序删：先叶子后目录，否则子项变孤儿被提到侧边栏根上
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    op.drop_index('ix_sys_notification_delivery_due', table_name='sys_notification_delivery')
    for name in ('created_time', 'channel', 'kind', 'user_id', 'notification_id', 'id'):
        op.drop_index(op.f(f'ix_sys_notification_delivery_{name}'), table_name='sys_notification_delivery')
    op.drop_table('sys_notification_delivery')
    op.drop_index(op.f('ix_sys_notification_pref_user_id'), table_name='sys_notification_pref')
    op.drop_index(op.f('ix_sys_notification_pref_id'), table_name='sys_notification_pref')
    op.drop_table('sys_notification_pref')
    op.drop_index(op.f('ix_sys_notification_policy_id'), table_name='sys_notification_policy')
    op.drop_table('sys_notification_policy')
