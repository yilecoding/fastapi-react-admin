"""MCP 凭据菜单图标：mdi:api → mdi:connection

Revision ID: ai000000mcpicon
Revises: ah000000userpref
Create Date: 2026-11-02 23:00:00+08:00

issue #210（美观度调研 P2）：`mdi:api` 在前端映射成 Tabler 的 `IconApi`，画出来是「API」
三个字母，MCP 凭据的页签 / 侧边栏 / ⌘K 里就是一行字而不是图标；同在「AI 助手」下的兄弟都是图形。
「能力开放」目录也用 `mdi:api`，那个语义贴切，不动。

纯数据迁移（插件种子 `plugin/ai/sql/*/init_snowflake.sql` 同步改了，新库由种子带上，
`fba init` 末尾 `stamp head` 不会执行这里）：

- 按业务键 `sys_menu.name` 定位，不写 ID（alembic 分册）
- 🔴 只改**还是旧值**的那一行：别人在菜单管理里自己换过图标的，不覆盖回去
- 一条普通 UPDATE，三个方言同一句；行不存在（没装 AI 插件）就是 0 行，天然幂等
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = 'ai000000mcpicon'
down_revision = 'ah000000userpref'
branch_labels = None
depends_on = None

_SQL = sa.text('UPDATE sys_menu SET icon = :new WHERE name = :name AND icon = :old')


def upgrade() -> None:
    op.execute(_SQL.bindparams(new='mdi:connection', name='AiMcpClient', old='mdi:api'))


def downgrade() -> None:
    op.execute(_SQL.bindparams(new='mdi:api', name='AiMcpClient', old='mdi:connection'))
