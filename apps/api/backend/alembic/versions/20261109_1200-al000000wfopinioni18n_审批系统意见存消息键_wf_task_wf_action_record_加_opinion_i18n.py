"""审批：系统意见存消息键 —— wf_task / wf_action_record 加 opinion_i18n

Revision ID: al000000wfopinioni18n
Revises: ak000000noticehtml
Create Date: 2026-11-09 12:00:00+08:00

自动驳回 / 自动跳过 / 超时自动处理 / AI 自动同意 / 离职交接这几句「系统意见」原来在写入那一刻按**触发请求的语言**
翻译成文本存进 `opinion`：英文界面的人触发的自动驳回，中文界面读出来还是英文；Celery 里跑的超时永远是默认语言。
现在另存 `{"key": ..., "args": {...}}`，读的时候按请求语言渲染（`plugin/workflow/sys_opinion.py`）。

- 可空、不回填：存量行是成品文本，哪个语言写的已经说不清，读的时候原样返回（和修之前一样）
- `opinion` 列含义不变（旧客户端、报表照旧读它），新写的系统意见在里面存一份默认语言的文本
- 带「列已经在就跳过」：开发服务器的 lifespan `create_all` 可能已经把列建好了（同 `y0000000aireviewver`）；
  没装审批插件（没有表）也跳过
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'al000000wfopinioni18n'
down_revision = 'ak000000noticehtml'
branch_labels = None
depends_on = None

_TABLES = ('wf_task', 'wf_action_record')
_COLUMN = 'opinion_i18n'


def _needs(table: str) -> bool:
    """表在、列不在"""
    insp = sa.inspect(op.get_bind())
    return insp.has_table(table) and not any(c['name'] == _COLUMN for c in insp.get_columns(table))


def upgrade() -> None:
    for table in _TABLES:
        if _needs(table):
            op.add_column(
                table,
                sa.Column(
                    _COLUMN,
                    backend.common.model.UniversalText(),
                    nullable=True,
                    comment='系统意见的消息键与参数（JSON）',
                ),
            )


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for table in _TABLES:
        if insp.has_table(table) and any(c['name'] == _COLUMN for c in insp.get_columns(table)):
            op.drop_column(table, _COLUMN)
