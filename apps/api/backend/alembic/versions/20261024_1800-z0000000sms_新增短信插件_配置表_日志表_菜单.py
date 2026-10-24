"""新增短信插件：配置表（sms_config）、发送日志表（sms_log），补齐已存在库缺的「短信」菜单

Revision ID: z0000000sms
Revises: y0000000aireviewver
Create Date: 2026-10-24 18:00:00

issue #153。两张表 + 10 条菜单放在一条里，是因为它们一起才构成「功能可用」：只建表不补菜单，表现是
**功能装好了但侧边栏里找不到入口**（`f0000000aimenu` 记过同一条）。

🔴 手写的建表要自己写 `autoincrement=False`：autogenerate 渲染不出模型侧的 Python 默认值，
SQL Server 上会把雪花主键建成 IDENTITY，那张表在生产里一行都写不进去（alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'z0000000sms'
down_revision = 'y0000000aireviewver'
branch_labels = None
depends_on = None

#: 和 `plugin/sms/sql/*/init_snowflake.sql` 同一套 ID，升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2230000000000000001, 'Sms', '短信', '/sms', 'mdi:message-text-outline', 0, None, 10, 1, None),
    (2230000000000000002, 'SmsConfig', '短信配置', '/sms/config', 'mdi:cellphone-message', 1, None, 1, 1, 'Sms'),
    (2230000000000000003, 'SmsLog', '发送日志', '/sms/log', 'mdi:message-badge-outline', 1, None, 2, 1, 'Sms'),
    (2230000000000000004, 'QuerySmsConfig', '查询', None, None, 2, 'sms:config:list', 0, 0, 'SmsConfig'),
    (2230000000000000005, 'AddSmsConfig', '新增', None, None, 2, 'sms:config:add', 1, 0, 'SmsConfig'),
    (2230000000000000006, 'EditSmsConfig', '修改', None, None, 2, 'sms:config:edit', 2, 0, 'SmsConfig'),
    (2230000000000000007, 'DeleteSmsConfig', '删除', None, None, 2, 'sms:config:del', 3, 0, 'SmsConfig'),
    (2230000000000000008, 'TestSmsConfig', '发测试短信', None, None, 2, 'sms:config:test', 4, 0, 'SmsConfig'),
    (2230000000000000009, 'QuerySmsLog', '查询', None, None, 2, 'sms:log:list', 0, 0, 'SmsLog'),
    (2230000000000000010, 'DeleteSmsLog', '删除', None, None, 2, 'sms:log:del', 1, 0, 'SmsLog'),
]


def upgrade() -> None:
    op.create_table(
        'sms_config',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('name', backend.common.model.UniversalStr(length=64), nullable=False, comment='配置名称（展示用）'),
        sa.Column(
            'provider',
            backend.common.model.UniversalStr(length=32),
            nullable=False,
            comment='厂商码（SDK 注册表里的 code）',
        ),
        sa.Column(
            'sign_name',
            backend.common.model.UniversalStr(length=64),
            nullable=False,
            comment='短信签名（须已审核通过）',
        ),
        sa.Column(
            'options',
            backend.common.model.UniversalText(),
            nullable=False,
            comment='厂商独有配置，JSON 文本（按厂商 Config 校验）',
        ),
        sa.Column(
            'templates',
            backend.common.model.UniversalText(),
            nullable=False,
            comment='业务模板码 → 厂商模板映射，JSON 文本（形状由厂商 TemplateMapping 决定）',
        ),
        sa.Column(
            'access_key_id',
            backend.common.model.UniversalStr(length=128),
            nullable=True,
            comment='凭据 key（明文；控制台厂商为空）',
        ),
        sa.Column(
            'secret_cipher', backend.common.model.UniversalText(), nullable=True, comment='凭据 secret 密文（AES）'
        ),
        sa.Column(
            'secret_mask',
            backend.common.model.UniversalStr(length=64),
            nullable=True,
            comment='凭据 secret 掩码（展示用）',
        ),
        sa.Column('weight', sa.Integer(), nullable=False, comment='权重（加权随机分流用；0 = 不参与自动选取）'),
        sa.Column(
            'daily_max', sa.Integer(), nullable=False, comment='每个自然日的发送上限（0 = 不限；到了就退出自动选取）'
        ),
        sa.Column('timeout', sa.Integer(), nullable=False, comment='请求超时（秒），显式传给 SDK'),
        sa.Column('is_default', sa.Boolean(), nullable=False, comment='是否默认配置（同一时间只有一条）'),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0：停用、1：正常）'),
        sa.Column('remark', backend.common.model.UniversalText(), nullable=True, comment='备注'),
        sa.Column('created_by', sa.BigInteger(), nullable=True, comment='创建者 ID'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.Column(
            'deleted', sa.BigInteger(), server_default='0', nullable=False, comment='是否已删除（0：否；id：是）'
        ),
        sa.Column('deleted_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='删除时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='短信配置表',
    )
    op.create_index(op.f('ix_sms_config_id'), 'sms_config', ['id'], unique=True)

    op.create_table(
        'sms_log',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column(
            'provider',
            backend.common.model.UniversalStr(length=32),
            nullable=False,
            comment='厂商码（冗余，配置删了还读得懂）',
        ),
        sa.Column(
            'phone',
            backend.common.model.UniversalStr(length=32),
            nullable=False,
            comment='手机号（完整存，列表接口掩码）',
        ),
        sa.Column(
            'template',
            backend.common.model.UniversalStr(length=64),
            nullable=False,
            comment='业务模板码（测试短信为 test）',
        ),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0 失败 · 1 已受理 · 2 结果未知 · 3 发送中）'),
        sa.Column('config_id', sa.BigInteger(), nullable=True, comment='走的哪条配置'),
        sa.Column('template_id', backend.common.model.UniversalStr(length=64), nullable=True, comment='厂商模板 ID'),
        sa.Column(
            'params', backend.common.model.UniversalText(), nullable=True, comment='厂商侧参数 JSON（敏感参数已打码）'
        ),
        sa.Column(
            'error_kind',
            backend.common.model.UniversalStr(length=32),
            nullable=True,
            comment='错误类型（SmsErrorKind）',
        ),
        sa.Column(
            'provider_code', backend.common.model.UniversalStr(length=64), nullable=True, comment='厂商原始错误码'
        ),
        sa.Column(
            'provider_msg', backend.common.model.UniversalText(), nullable=True, comment='厂商原始文案 / 异常文本'
        ),
        sa.Column('request_id', backend.common.model.UniversalStr(length=128), nullable=True, comment='厂商请求 ID'),
        sa.Column(
            'biz_id',
            backend.common.model.UniversalStr(length=128),
            nullable=True,
            comment='厂商回执 ID（阿里云 BizId / 腾讯云 SerialNo）',
        ),
        sa.Column('duration_ms', sa.Integer(), nullable=True, comment='请求耗时（毫秒）'),
        sa.Column('created_by', sa.BigInteger(), nullable=True, comment='发起人 ID（匿名接口为空）'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='短信发送日志表',
    )
    op.create_index(op.f('ix_sms_log_id'), 'sms_log', ['id'], unique=True)
    op.create_index(op.f('ix_sms_log_phone'), 'sms_log', ['phone'], unique=False)
    op.create_index(op.f('ix_sms_log_template'), 'sms_log', ['template'], unique=False)
    op.create_index(op.f('ix_sms_log_status'), 'sms_log', ['status'], unique=False)
    op.create_index(op.f('ix_sms_log_config_id'), 'sms_log', ['config_id'], unique=False)
    op.create_index(op.f('ix_sms_log_error_kind'), 'sms_log', ['error_kind'], unique=False)
    op.create_index(op.f('ix_sms_log_created_time'), 'sms_log', ['created_time'], unique=False)

    if not seeded_pk_mode() or not check_plugin_installed('sms'):
        # 自增主键模式没有基础种子；插件卸载了不该插一个点进去 404 的菜单（同 f0000000aimenu）
        return
    conn = op.get_bind()
    # 顺序不能乱：父级按 name 解析，目录必须先于它的子项插入
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
        # 倒序删：先叶子后目录，否则子项变孤儿被提到侧边栏根上
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    for name in ('created_time', 'error_kind', 'config_id', 'status', 'template', 'phone', 'id'):
        op.drop_index(op.f(f'ix_sms_log_{name}'), table_name='sms_log')
    op.drop_table('sms_log')
    op.drop_index(op.f('ix_sms_config_id'), table_name='sms_config')
    op.drop_table('sms_config')
