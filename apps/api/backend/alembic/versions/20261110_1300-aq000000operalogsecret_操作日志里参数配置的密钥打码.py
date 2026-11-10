"""操作日志里参数配置的密钥打码（已经写进去的那些行）

Revision ID: aq000000operalogsecret
Revises: ap000000logretention
Create Date: 2026-11-10 13:00:00

操作日志原来认不出参数配置那种 `{"key": "EMAIL_PASSWORD", "value": …}` 的行，批量保存的请求体还被 `str()` 成
一段 repr、一个字符都不打码。中间件修好之后，这条把**已经写进去的**行按同一条规则清一遍
（`app/admin/utils/opera_log_scrub.py`）。

- 只改数据，不改结构；可以重复跑（清过的行不再变）
- 离线生成 SQL（`--sql`）时没有数据可读，跳过
- 新库（`fba init`）没有旧日志，`stamp head` 标成已应用即可
- downgrade 什么都不做：打掉的值找不回来，也不该找回来
"""

from alembic import context, op

# revision identifiers, used by Alembic.
revision = 'aq000000operalogsecret'
down_revision = 'ap000000logretention'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if context.is_offline_mode():
        return
    from backend.app.admin.utils.opera_log_scrub import scrub_config_secrets
    from backend.common.log import log

    changed = scrub_config_secrets(op.get_bind())
    log.info(f'操作日志：{changed} 行里的参数配置密钥已打码')


def downgrade() -> None:
    pass
