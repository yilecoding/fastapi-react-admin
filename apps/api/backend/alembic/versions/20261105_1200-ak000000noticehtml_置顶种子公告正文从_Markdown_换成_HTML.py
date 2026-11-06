"""置顶种子公告正文：Markdown → HTML

Revision ID: ak000000noticehtml
Revises: aj000000tasklist
Create Date: 2026-11-05 12:00:00+08:00

种子里那条置顶公告（「系统升级公告：新增定时任务与数据权限模块」）的正文写成了 **Markdown**
（`* **定时任务调度**：…`）。公告正文的约定是 Tiptap 产出的 HTML，两端都不认 Markdown：
移动端按纯文本分段、把 `*` 和 `**` 原样显示出来；web 端交给 Tiptap 当 HTML 解析，
换行被折掉，整条挤成一段、星号照样在。

纯数据迁移（插件种子 `plugin/notice/sql/*/init_snowflake.sql` 同步改了，新库由种子带上，
`fba init` 末尾 `stamp head` 不会执行这里）：

- 三个方言的种子用的是同一个 ID，按 ID 定位
- 🔴 只改**正文还是原来那段 Markdown** 的那一行：管理员在界面上改过的不覆盖。
  比较放在 Python 里做（换行统一成 `\n` 再比），不在 SQL 里比大字段 —— 种子文件是 CRLF，
  各方言存进去的换行未必一致
- 行不存在（没装公告插件 / 已删除）就什么都不做，天然幂等
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = 'ak000000noticehtml'
down_revision = 'aj000000tasklist'
branch_labels = None
depends_on = None

_ID = 2112248797756129280

_MARKDOWN = """各位同事：

系统本次升级新增了以下功能：

* **定时任务调度**：支持在「系统管理 - 定时任务」里配置周期任务，查看每次执行的详细记录
* **数据权限矩阵**：可以按部门/角色精细控制不同用户能看到哪些数据，详见「系统管理 - 数据权限」

升级期间历史数据不受影响，如有问题请联系系统管理员。"""

_HTML = (
    '<p>各位同事：</p><p>系统本次升级新增了以下功能：</p><ul>'
    '<li><p><strong>定时任务调度</strong>：支持在「系统管理 - 定时任务」里配置周期任务，查看每次执行的详细记录</p></li>'
    '<li><p><strong>数据权限矩阵</strong>：可以按部门/角色精细控制不同用户能看到哪些数据，'
    '详见「系统管理 - 数据权限」</p></li>'
    '</ul><p>升级期间历史数据不受影响，如有问题请联系系统管理员。</p>'
)


def _normalize(s: str | None) -> str:
    return (s or '').replace('\r\n', '\n').replace('\r', '\n').strip()


def _swap(old: str, new: str) -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table('sys_notice'):
        return
    row = bind.execute(sa.text('SELECT content FROM sys_notice WHERE id = :id'), {'id': _ID}).first()
    if row is None or _normalize(row[0]) != _normalize(old):
        return
    bind.execute(sa.text('UPDATE sys_notice SET content = :new WHERE id = :id'), {'new': new, 'id': _ID})


def upgrade() -> None:
    _swap(_MARKDOWN, _HTML)


def downgrade() -> None:
    _swap(_HTML, _MARKDOWN)
