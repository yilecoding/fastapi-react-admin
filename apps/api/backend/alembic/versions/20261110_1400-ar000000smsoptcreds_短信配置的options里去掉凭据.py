"""短信配置：去掉混进 options 的凭据

Revision ID: ar000000smsoptcreds
Revises: aq000000operalogsecret
Create Date: 2026-11-10 14:00:00

#281 / #284 评审。保存时现在拒收「凭据放在 options 里」，这之前存进去的行由这条清掉
（`plugin/sms/service/config_service.py: strip_credential_options`）：详情接口不再下发明文、改那一行时不会把明文带进
数据变更记录、那一行也能正常保存了。这些键本来就不起作用（发送时用的是凭据栏）。

- 只改数据，不改结构；可以重复跑
- 认不出的厂商（第三方厂商插件没装）不知道哪些字段是凭据，那一行不动，日志里说一声
- 离线生成 SQL（`--sql`）时没有数据可读，跳过；新库（`fba init`）没有旧配置
- downgrade 什么都不做：删掉的明文凭据不该再写回去
"""

from alembic import context, op

# revision identifiers, used by Alembic.
revision = 'ar000000smsoptcreds'
down_revision = 'aq000000operalogsecret'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if context.is_offline_mode():
        return
    from backend.common.log import log
    from backend.plugin.sms.service.config_service import strip_credential_options

    changed, skipped = strip_credential_options(op.get_bind())
    log.info(f'短信配置：{changed} 行的 options 里去掉了凭据')
    if skipped:
        log.warning(f'短信配置：{skipped} 行的厂商认不出（插件没装？），没法判断 options 里哪些是凭据，没动')


def downgrade() -> None:
    pass
