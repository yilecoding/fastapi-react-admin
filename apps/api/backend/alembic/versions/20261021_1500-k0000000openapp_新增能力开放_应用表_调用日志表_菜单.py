"""新增能力开放：应用表（open_app）、调用日志表（open_api_log），补齐已存在库缺的菜单（#118）

Revision ID: k0000000openapp
Revises: j0000000aimcpwrite
Create Date: 2026-10-21 15:00:00

建表和菜单放在一条里，理由同 `i0000000aimcpcli`：只建表不补菜单，表现是功能装好了但侧边栏里找不到入口。

🔴 手写的建表要自己写 `autoincrement=False`：autogenerate 渲染不出模型侧的 Python 默认值，
SQL Server 上会把雪花主键建成 IDENTITY，那张表在生产里一行都写不进去（alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'k0000000openapp'
down_revision = 'j0000000aimcpwrite'
branch_labels = None
depends_on = None

#: 和 `plugin/open/sql/*/init_snowflake.sql` 同一套 ID，升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2220000000000000001, 'OpenPlatform', '能力开放', '/open', 'mdi:api', 0, None, 9, 1, None),
    (2220000000000000002, 'OpenApp', '应用管理', '/open/app', 'mdi:key-variant', 1, None, 1, 1, 'OpenPlatform'),
    (2220000000000000003, 'QueryOpenApp', '查询', None, None, 2, 'open:app:list', 0, 0, 'OpenApp'),
    (2220000000000000004, 'AddOpenApp', '新增', None, None, 2, 'open:app:add', 1, 0, 'OpenApp'),
    (2220000000000000005, 'EditOpenApp', '修改', None, None, 2, 'open:app:edit', 2, 0, 'OpenApp'),
    (2220000000000000006, 'ResetOpenAppSecret', '重置密钥', None, None, 2, 'open:app:reset', 3, 0, 'OpenApp'),
    (2220000000000000007, 'DeleteOpenApp', '删除', None, None, 2, 'open:app:del', 4, 0, 'OpenApp'),
    (2220000000000000008, 'QueryOpenApiLog', '调用日志', None, None, 2, 'open:log:list', 5, 0, 'OpenApp'),
]


def upgrade() -> None:
    op.create_table(
        'open_app',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('name', backend.common.model.UniversalStr(length=64), nullable=False, comment='应用名称'),
        sa.Column(
            'code',
            backend.common.model.UniversalStr(length=32),
            nullable=False,
            comment='应用编码（调用日志里显示为 app:<code>）',
        ),
        sa.Column(
            'access_key',
            backend.common.model.UniversalStr(length=64),
            nullable=False,
            comment='Access Key（公开标识，明文）',
        ),
        sa.Column(
            'secret_cipher', backend.common.model.UniversalText(), nullable=False, comment='Secret Key 密文（AES）'
        ),
        sa.Column(
            'secret_hint',
            backend.common.model.UniversalStr(length=24),
            nullable=False,
            comment='Secret Key 前几位（只用于辨认）',
        ),
        sa.Column(
            'scopes', backend.common.model.UniversalText(), nullable=False, comment='授权调用的开放接口 JSON 数组'
        ),
        sa.Column(
            'ip_whitelist',
            backend.common.model.UniversalText(),
            nullable=True,
            comment='来源 IP 白名单 JSON 数组（NULL = 不限）',
        ),
        sa.Column('rate_per_minute', sa.Integer(), nullable=True, comment='每分钟请求上限（NULL = 用全局默认）'),
        sa.Column(
            'expire_time',
            backend.common.model.TimeZone(timezone=True),
            nullable=True,
            comment='失效时间（NULL = 不过期）',
        ),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0：停用、1：正常）'),
        sa.Column(
            'last_used_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='最近一次调用的时间'
        ),
        sa.Column('remark', backend.common.model.UniversalText(), nullable=True, comment='备注'),
        sa.Column('created_by', sa.BigInteger(), nullable=True, comment='创建者 ID'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.Column(
            'deleted', sa.BigInteger(), server_default='0', nullable=False, comment='是否已删除（0：否；id：是）'
        ),
        sa.Column('deleted_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='删除时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('code', 'deleted', name='uk_open_app_code_deleted'),
        sa.UniqueConstraint('access_key'),
        comment='能力开放应用表',
    )
    op.create_index(op.f('ix_open_app_id'), 'open_app', ['id'], unique=True)
    op.create_index(op.f('ix_open_app_code'), 'open_app', ['code'], unique=False)

    op.create_table(
        'open_api_log',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('trace_id', backend.common.model.UniversalStr(length=32), nullable=False, comment='请求跟踪 ID'),
        sa.Column('app_id', sa.BigInteger(), nullable=True, comment='应用 ID（AK 无效时为空）'),
        sa.Column(
            'app_code', backend.common.model.UniversalStr(length=32), nullable=True, comment='应用编码（调用时的快照）'
        ),
        sa.Column(
            'app_name', backend.common.model.UniversalStr(length=64), nullable=True, comment='应用名称（调用时的快照）'
        ),
        sa.Column(
            'access_key', backend.common.model.UniversalStr(length=64), nullable=True, comment='请求里带来的 Access Key'
        ),
        sa.Column('method', backend.common.model.UniversalStr(length=16), nullable=False, comment='请求方法'),
        sa.Column('title', backend.common.model.UniversalStr(length=256), nullable=False, comment='接口摘要'),
        sa.Column('path', backend.common.model.UniversalStr(length=512), nullable=False, comment='请求路径'),
        sa.Column('scope', backend.common.model.UniversalStr(length=64), nullable=True, comment='本接口需要的 scope'),
        sa.Column('scope_granted', sa.Boolean(), nullable=True, comment='调用时该应用是否已授权本接口'),
        sa.Column('ip', backend.common.model.UniversalStr(length=64), nullable=False, comment='来源 IP'),
        sa.Column('ip_whitelisted', sa.Boolean(), nullable=True, comment='来源 IP 是否在白名单内（白名单为空记为是）'),
        sa.Column('country', backend.common.model.UniversalStr(length=64), nullable=True, comment='国家'),
        sa.Column('region', backend.common.model.UniversalStr(length=64), nullable=True, comment='地区'),
        sa.Column('city', backend.common.model.UniversalStr(length=64), nullable=True, comment='城市'),
        sa.Column('user_agent', backend.common.model.UniversalStr(length=512), nullable=True, comment='用户代理'),
        sa.Column('os', backend.common.model.UniversalStr(length=64), nullable=True, comment='操作系统'),
        sa.Column('browser', backend.common.model.UniversalStr(length=64), nullable=True, comment='浏览器'),
        sa.Column('device', backend.common.model.UniversalStr(length=64), nullable=True, comment='设备'),
        sa.Column('args', sa.JSON(), nullable=True, comment='请求参数'),
        sa.Column('request_headers', sa.JSON(), nullable=True, comment='请求头（已脱敏）'),
        sa.Column('response_headers', sa.JSON(), nullable=True, comment='响应头'),
        sa.Column('response_body', backend.common.model.UniversalText(), nullable=True, comment='响应体（超限截断）'),
        sa.Column('status', sa.Integer(), nullable=False, comment='调用结果（0失败 1成功）'),
        sa.Column('code', backend.common.model.UniversalStr(length=32), nullable=False, comment='HTTP 状态码'),
        sa.Column(
            'error_code',
            backend.common.model.UniversalStr(length=64),
            nullable=False,
            comment='ok 或失败原因（open.sign_mismatch…）',
        ),
        sa.Column('msg', backend.common.model.UniversalText(), nullable=True, comment='提示消息'),
        sa.Column('row_count', sa.Integer(), nullable=True, comment='返回条数（同步类接口）'),
        sa.Column('cost_time', sa.Float(), nullable=False, comment='请求耗时（ms）'),
        sa.Column('request_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='调用时间'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='能力开放调用日志表',
    )
    op.create_index(op.f('ix_open_api_log_id'), 'open_api_log', ['id'], unique=True)
    op.create_index(op.f('ix_open_api_log_app_id'), 'open_api_log', ['app_id'], unique=False)
    op.create_index(op.f('ix_open_api_log_error_code'), 'open_api_log', ['error_code'], unique=False)
    op.create_index(op.f('ix_open_api_log_request_time'), 'open_api_log', ['request_time'], unique=False)

    if not seeded_pk_mode() or not check_plugin_installed('open'):
        # 自增主键模式没有基础种子；插件卸载了不该插一个点进去 404 的菜单（同 f0000000aimenu）
        return
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
        # 倒序删：先叶子后目录，否则子项变孤儿被提到侧边栏根上
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    op.drop_index(op.f('ix_open_api_log_request_time'), table_name='open_api_log')
    op.drop_index(op.f('ix_open_api_log_error_code'), table_name='open_api_log')
    op.drop_index(op.f('ix_open_api_log_app_id'), table_name='open_api_log')
    op.drop_index(op.f('ix_open_api_log_id'), table_name='open_api_log')
    op.drop_table('open_api_log')
    op.drop_index(op.f('ix_open_app_code'), table_name='open_app')
    op.drop_index(op.f('ix_open_app_id'), table_name='open_app')
    op.drop_table('open_app')
