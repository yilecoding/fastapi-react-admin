"""操作日志里漏打码的凭据清理（已经写进去的那些行）

Revision ID: aq000000operalogsecret
Revises: ap000000logretention
Create Date: 2026-11-10 13:00:00

中间件原来漏了参数配置的 key / value 形状、列表请求体、以及名单里没有的字段名（`access_token` · `api_key` ·
`import_token` · `token`）。中间件修好之后，这条把**已经写进去的**行按同一条规则清一遍
（`app/admin/utils/opera_log_scrub.py`，只扫会写出这些东西的接口）。

- 只改数据，不改结构；可以重复跑（清过的行、新中间件写下的行都不再变；只有「查看操作日志」那种行，响应体总会换成占位）
- 🔴 部署时旧进程在迁移扫完之后还写进来的那几十秒（队列最长 60 秒一批），扫不到 —— 所以发版说明要建议换密钥
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
    from backend.app.admin.utils.opera_log_scrub import scrub_logged_secrets
    from backend.common.log import log

    # 🔴 边扫边提交，不在迁移的那一个事务里改完再提交（#283 评审）：登录 / 刷新的日志一个活跃用户半小时就一条，
    # 全改在一个事务里就是几十万行的锁一直攥到最后 —— 部署时旧进程还在写日志、清理任务还在删，
    # SQL Server 上会排队甚至升级成表锁。
    # 每一行的改写本身是幂等的，中途断了重跑接着清
    with op.get_context().autocommit_block():
        changed = scrub_logged_secrets(op.get_bind())
    log.info(f'操作日志：{changed} 行里的凭据已打码')


def downgrade() -> None:
    pass
