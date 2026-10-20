"""新增 MCP 凭据表（ai_mcp_client），补齐已存在库缺的「MCP 凭据」菜单

Revision ID: i0000000aimcpcli
Revises: h0000000aichannel
Create Date: 2026-10-20 14:00:00

MCP 网关的外部系统凭据原来写在 `.env`（`AI_MCP_CLIENTS`），改成表 + 管理页：
发凭据不用改配置重启、能停用 / 换令牌、能看到最近使用时间。

两件事放在一条里，是因为它们一起才构成「功能可用」：只建表不补菜单，表现是
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
revision = 'i0000000aimcpcli'
down_revision = 'h0000000aichannel'
branch_labels = None
depends_on = None

#: 和 `plugin/ai/sql/*/init_snowflake.sql` 同一套 ID，升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2210000000000000011, 'AiMcpClient', 'MCP 凭据', '/ai/mcp-client', 'mdi:api', 1, None, 4, 1, 'AiAssistant'),
    (2210000000000000012, 'QueryAiMcpClient', '查询', None, None, 2, 'ai:mcp:list', 0, 0, 'AiMcpClient'),
    (2210000000000000013, 'AddAiMcpClient', '新增', None, None, 2, 'ai:mcp:add', 1, 0, 'AiMcpClient'),
    (2210000000000000014, 'EditAiMcpClient', '修改', None, None, 2, 'ai:mcp:edit', 2, 0, 'AiMcpClient'),
    (2210000000000000015, 'DeleteAiMcpClient', '删除', None, None, 2, 'ai:mcp:del', 3, 0, 'AiMcpClient'),
]


def upgrade() -> None:
    op.create_table(
        'ai_mcp_client',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column(
            'client_id',
            backend.common.model.UniversalStr(length=48),
            nullable=False,
            comment='凭据标识（审计里显示为 mcp:<client_id>）',
        ),
        sa.Column(
            'name', backend.common.model.UniversalStr(length=64), nullable=False, comment='外部系统名称（展示用）'
        ),
        sa.Column(
            'token_sha256', backend.common.model.UniversalStr(length=64), nullable=False, comment='令牌的 sha256'
        ),
        sa.Column(
            'token_hint',
            backend.common.model.UniversalStr(length=24),
            nullable=False,
            comment='令牌前几位（只用于辨认）',
        ),
        sa.Column(
            'act_as',
            backend.common.model.UniversalText(),
            nullable=False,
            comment='可代表的用户名 JSON 数组（"*" = 任何普通用户）',
        ),
        sa.Column('allow_superuser', sa.Boolean(), nullable=False, comment='是否允许代表超级管理员'),
        sa.Column(
            'tools', backend.common.model.UniversalText(), nullable=True, comment='工具白名单 JSON 数组（NULL = 不限）'
        ),
        sa.Column('rate_per_minute', sa.Integer(), nullable=True, comment='每分钟请求上限（NULL = 用全局默认）'),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0：停用、1：正常）'),
        sa.Column(
            'last_used_time',
            backend.common.model.TimeZone(timezone=True),
            nullable=True,
            comment='最近一次成功鉴权的时间',
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
        comment='MCP 网关外部系统凭据表',
    )
    op.create_index(op.f('ix_ai_mcp_client_id'), 'ai_mcp_client', ['id'], unique=True)
    op.create_index(op.f('ix_ai_mcp_client_client_id'), 'ai_mcp_client', ['client_id'], unique=False)
    op.create_index(op.f('ix_ai_mcp_client_token_sha256'), 'ai_mcp_client', ['token_sha256'], unique=False)

    if not seeded_pk_mode() or not check_plugin_installed('ai'):
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
    op.drop_index(op.f('ix_ai_mcp_client_token_sha256'), table_name='ai_mcp_client')
    op.drop_index(op.f('ix_ai_mcp_client_client_id'), table_name='ai_mcp_client')
    op.drop_index(op.f('ix_ai_mcp_client_id'), table_name='ai_mcp_client')
    op.drop_table('ai_mcp_client')
