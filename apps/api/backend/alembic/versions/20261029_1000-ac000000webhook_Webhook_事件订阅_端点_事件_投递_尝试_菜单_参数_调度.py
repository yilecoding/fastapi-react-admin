"""Webhook 事件订阅：端点表 · 事件表 · 投递表 · 尝试表，补齐已存在库缺的按钮 / 参数配置组 / 投递调度

Revision ID: ac000000webhook
Revises: ab000000notifych
Create Date: 2026-10-29 10:00:00

issue #167。四张表 + 7 个按钮 + 「Webhook」参数组 5 行 + 投递调度 1 行放在一条里：它们一起才构成「功能可用」
（只建表不补调度，表现是投递一直停在「待发」—— `ab000000notifych` 头注释那条）。

🔴 手写的建表要自己写 `autoincrement=False`：SQL Server 上会把雪花主键建成 IDENTITY（alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'ac000000webhook'
down_revision = 'ab000000notifych'
branch_labels = None
depends_on = None

#: 和 `plugin/open/sql/*/init_snowflake.sql` 同一套 ID。(menu_id, name, title, perms, sort)，都挂在「应用管理」下
_BUTTONS = [
    (2220000000000000009, 'QueryOpenWebhook', 'Webhook 查询', 'open:webhook:list', 6),
    (2220000000000000010, 'AddOpenWebhook', 'Webhook 新增', 'open:webhook:add', 7),
    (2220000000000000011, 'EditOpenWebhook', 'Webhook 修改', 'open:webhook:edit', 8),
    (2220000000000000012, 'DeleteOpenWebhook', 'Webhook 删除', 'open:webhook:del', 9),
    (2220000000000000013, 'ResetOpenWebhookSecret', 'Webhook 重置密钥', 'open:webhook:reset', 10),
    (2220000000000000014, 'TestOpenWebhook', 'Webhook 发测试', 'open:webhook:test', 11),
    (2220000000000000015, 'ResendOpenWebhook', 'Webhook 重发', 'open:webhook:resend', 12),
]

#: 照抄 `plugin/config/sql/*/init_snowflake.sql` 里那几个 ID（三个方言同一套）
_CONFIG_ROWS = (
    (2224875016875409428, '状态', 'OPEN_WEBHOOK_CONFIG_STATUS', '1', None),
    (
        2224875016875409429,
        'Webhook 总开关',
        'OPEN_WEBHOOK_ENABLED',
        'true',
        '关掉后事件照记，但不再给任何端点生成投递（已经在排队的照常发完）',
    ),
    (
        2224875016875409430,
        '自动停用阈值',
        'OPEN_WEBHOOK_DISABLE_AFTER',
        '20',
        '连续失败这么多次、且第一次失败已过去 24 小时，自动停用端点并通知应用创建人',
    ),
    (
        2224875016875409431,
        '记录保留（天）',
        'OPEN_WEBHOOK_RETENTION_DAYS',
        '30',
        '事件、投递、每次尝试的记录，每天凌晨的日志清理一起删',
    ),
    (2224875016875409432, '每个应用最多端点数', 'OPEN_WEBHOOK_MAX_PER_APP', '10', None),
)

_SCHEDULER_ID = 2220000000000000101
_TASK = 'open.webhook_deliver_pending'
_REMARK = (
    '每 15 秒把到点的 Webhook 事件签名 POST 给对接方（安全网：写了投递的事务提交后也会立刻踢一次）。'
    '停用后投递会一直停在「待发」'
)


def upgrade() -> None:
    ustr = backend.common.model.UniversalStr
    utext = backend.common.model.UniversalText
    tz = backend.common.model.TimeZone

    op.create_table(
        'open_webhook',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('app_id', sa.BigInteger(), nullable=False, comment='所属应用 ID'),
        sa.Column('name', ustr(length=64), nullable=False, comment='端点名称'),
        sa.Column('url', ustr(length=512), nullable=False, comment='接收地址'),
        sa.Column('secret_cipher', utext(), nullable=False, comment='签名密钥密文（AES）'),
        sa.Column('secret_hint', ustr(length=24), nullable=False, comment='签名密钥前几位（只用于辨认）'),
        sa.Column('events', utext(), nullable=False, comment='订阅的事件类型 JSON 数组（支持 user.* 前缀通配）'),
        sa.Column('secret_prev_cipher', utext(), nullable=True, comment='轮换前的旧密钥密文（过期前两把都签）'),
        sa.Column('secret_prev_expire_time', tz(timezone=True), nullable=True, comment='旧密钥停止签名的时间'),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0：停用、1：正常）'),
        sa.Column('disabled_reason', ustr(length=16), nullable=True, comment='停用原因（manual / auto / gone）'),
        sa.Column('disabled_time', tz(timezone=True), nullable=True, comment='停用时间'),
        sa.Column('consecutive_failures', sa.Integer(), nullable=False, comment='连续失败次数（成功一次清零）'),
        sa.Column('first_failure_time', tz(timezone=True), nullable=True, comment='这一轮连续失败的第一次时间'),
        sa.Column('last_delivery_time', tz(timezone=True), nullable=True, comment='最近一次投递时间'),
        sa.Column('last_success_time', tz(timezone=True), nullable=True, comment='最近一次成功时间'),
        sa.Column('remark', utext(), nullable=True, comment='备注'),
        sa.Column('created_by', sa.BigInteger(), nullable=True, comment='创建者 ID'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', tz(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='能力开放 Webhook 端点表',
    )
    op.create_index(op.f('ix_open_webhook_id'), 'open_webhook', ['id'], unique=True)
    op.create_index(op.f('ix_open_webhook_app_id'), 'open_webhook', ['app_id'], unique=False)

    op.create_table(
        'open_event',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('type', ustr(length=64), nullable=False, comment='事件类型（dept.updated…）'),
        sa.Column('aggregate_id', sa.BigInteger(), nullable=True, comment='事件主体的 ID'),
        sa.Column('payload', utext(), nullable=False, comment='请求体原文（JSON，签名就签这一份）'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='能力开放事件表',
    )
    for name in ('id', 'type', 'aggregate_id', 'created_time'):
        op.create_index(op.f(f'ix_open_event_{name}'), 'open_event', [name], unique=name == 'id')

    op.create_table(
        'open_webhook_delivery',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('webhook_id', sa.BigInteger(), nullable=False, comment='端点 ID'),
        sa.Column('event_id', sa.BigInteger(), nullable=False, comment='事件 ID（= webhook-id）'),
        sa.Column('event_type', ustr(length=64), nullable=False, comment='事件类型（冗余，列表筛选用）'),
        sa.Column(
            'status',
            ustr(length=16),
            nullable=False,
            comment='状态（pending / sending / success / failed / exhausted）',
        ),
        sa.Column('attempts', sa.Integer(), nullable=False, comment='已尝试次数'),
        sa.Column('next_attempt_time', tz(timezone=True), nullable=True, comment='下一次尝试的时间（不会再试时为空）'),
        sa.Column('last_response_code', sa.Integer(), nullable=True, comment='最近一次的 HTTP 状态码'),
        sa.Column('last_error', utext(), nullable=True, comment='最近一次的错误'),
        sa.Column('last_duration_ms', sa.Integer(), nullable=True, comment='最近一次的耗时（毫秒）'),
        sa.Column('success_time', tz(timezone=True), nullable=True, comment='成功的时间'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', tz(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='能力开放 Webhook 投递表',
    )
    for name in ('id', 'webhook_id', 'event_id', 'event_type'):
        op.create_index(op.f(f'ix_open_webhook_delivery_{name}'), 'open_webhook_delivery', [name], unique=name == 'id')
    op.create_index('ix_open_webhook_delivery_due', 'open_webhook_delivery', ['status', 'next_attempt_time'])
    op.create_index('ix_open_webhook_delivery_created_time', 'open_webhook_delivery', ['created_time'])

    op.create_table(
        'open_webhook_attempt',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('delivery_id', sa.BigInteger(), nullable=False, comment='投递 ID'),
        sa.Column('attempt', sa.Integer(), nullable=False, comment='第几次尝试（从 1 起）'),
        sa.Column('url', ustr(length=512), nullable=False, comment='这次发往的地址'),
        sa.Column('request_headers', sa.JSON(), nullable=True, comment='请求头（签名已打码）'),
        sa.Column('response_code', sa.Integer(), nullable=True, comment='HTTP 状态码（没收到响应为空）'),
        sa.Column('response_headers', sa.JSON(), nullable=True, comment='响应头'),
        sa.Column('response_body', utext(), nullable=True, comment='响应体（脱敏 + 截断）'),
        sa.Column('error', utext(), nullable=True, comment='错误（超时 / 连接失败 / 地址被拦）'),
        sa.Column('duration_ms', sa.Integer(), nullable=False, comment='耗时（毫秒）'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='尝试时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='能力开放 Webhook 投递尝试表',
    )
    for name in ('id', 'delivery_id', 'created_time'):
        op.create_index(op.f(f'ix_open_webhook_attempt_{name}'), 'open_webhook_attempt', [name], unique=name == 'id')

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    conn = op.get_bind()
    if check_plugin_installed('open'):
        for menu_id, name, title, perms, sort in _BUTTONS:
            add_menu(
                conn,
                menu_id=menu_id,
                name=name,
                title=title,
                path=None,
                perms=perms,
                icon=None,
                menu_type=2,
                sort=sort,
                display=0,
                parent_name='OpenApp',
            )
        # 按 `task` 判存在，不按 `name`：名字管理员能在界面上改（同 u0000000health）
        insert_if_absent(
            conn,
            'task_scheduler',
            {'task': _TASK},
            {
                'id': _SCHEDULER_ID,
                'name': 'Webhook 投递',
                'args': None,
                'kwargs': None,
                'queue': None,
                'exchange': None,
                'routing_key': None,
                'start_time': None,
                'expire_time': None,
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
            insert_if_absent(
                conn,
                'sys_config',
                {'key': key},
                {
                    'id': pk,
                    'name': name,
                    'type': 'OPEN_WEBHOOK',
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
        for button in reversed(_BUTTONS):
            delete_by_key(conn, 'sys_menu', name=button[1])
    for name in ('created_time', 'delivery_id', 'id'):
        op.drop_index(op.f(f'ix_open_webhook_attempt_{name}'), table_name='open_webhook_attempt')
    op.drop_table('open_webhook_attempt')
    op.drop_index('ix_open_webhook_delivery_created_time', table_name='open_webhook_delivery')
    op.drop_index('ix_open_webhook_delivery_due', table_name='open_webhook_delivery')
    for name in ('event_type', 'event_id', 'webhook_id', 'id'):
        op.drop_index(op.f(f'ix_open_webhook_delivery_{name}'), table_name='open_webhook_delivery')
    op.drop_table('open_webhook_delivery')
    for name in ('created_time', 'aggregate_id', 'type', 'id'):
        op.drop_index(op.f(f'ix_open_event_{name}'), table_name='open_event')
    op.drop_table('open_event')
    op.drop_index(op.f('ix_open_webhook_app_id'), table_name='open_webhook')
    op.drop_index(op.f('ix_open_webhook_id'), table_name='open_webhook')
    op.drop_table('open_webhook')
