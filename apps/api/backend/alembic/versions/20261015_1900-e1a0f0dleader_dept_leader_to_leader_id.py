"""sys_dept.leader（自由文本）→ leader_id（用户 ID）

`leader` 原来是 `UniversalStr(32)`，存的是一个名字。审批流（issue #107）里
「部门负责人」「发起人上级」两类审批人规则都要**找得到那个人**，名字做不到。

## 存量回填

按 `sys_user.nickname` **精确且唯一**匹配：同名的人有两个就不填（留空比填错好 ——
填错的后果是审批静默地送到另一个人手里）。匹配不上的部门负责人变成空，
管理员在部门页重新选一次。

⚠️ 这一步**会丢信息**：匹配不上的那些名字，升级之后就没有了。downgrade
能把 leader_id 反查回昵称，但当初没匹配上的原文回不来。

Revision ID: e1a0f0dleader
Revises: 677aa7aa0f73
Create Date: 2026-10-15 19:00:00.000000+08:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'e1a0f0dleader'
down_revision = '677aa7aa0f73'
branch_labels = None
depends_on = None

_INDEX = 'ix_sys_dept_leader_id'


def upgrade() -> None:
    op.add_column('sys_dept', sa.Column('leader_id', sa.BigInteger(), nullable=True, comment='负责人用户 ID'))
    op.create_index(_INDEX, 'sys_dept', ['leader_id'], unique=False)
    # 相关子查询的 UPDATE 三个方言都认；不写 `UPDATE ... FROM`（mssql / pg 有、mysql 没有）
    op.execute(
        sa.text(
            """
            UPDATE sys_dept SET leader_id = (
                SELECT u.id FROM sys_user u WHERE u.nickname = sys_dept.leader AND u.deleted = 0
            )
            WHERE leader IS NOT NULL
              AND (SELECT COUNT(*) FROM sys_user u WHERE u.nickname = sys_dept.leader AND u.deleted = 0) = 1
            """
        )
    )
    op.drop_column('sys_dept', 'leader')


def downgrade() -> None:
    op.add_column(
        'sys_dept',
        sa.Column('leader', backend.common.model.UniversalStr(length=32), nullable=True, comment='负责人'),
    )
    op.execute(
        sa.text(
            """
            UPDATE sys_dept SET leader = (SELECT u.nickname FROM sys_user u WHERE u.id = sys_dept.leader_id)
            WHERE leader_id IS NOT NULL
            """
        )
    )
    # mssql 删列之前必须先删掉列上的索引
    op.drop_index(_INDEX, table_name='sys_dept')
    op.drop_column('sys_dept', 'leader_id')
