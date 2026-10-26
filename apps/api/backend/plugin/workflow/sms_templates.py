"""审批流用到的短信业务模板（#166）。短信插件启动时扫描这个模块（`plugin/sms/extensions.py`）。

管理员要在「短信配置」里把这两个码对到厂商侧审核过的模板。模板正文建议：
- `workflow_remind`：「您有一条审批被催办：${title}，请尽快处理。」
- `workflow_timeout`：「您有一条审批已超时：${title}，请尽快处理。」

冷却 / 日上限是防误刷的兜底：同一个人同一条模板 5 分钟内只收一条，一天最多 20 条。
"""

from backend.plugin.sms.templates import register_sms_template

register_sms_template(
    'workflow_remind',
    label='审批催办',
    params=('title',),
    sensitive=(),
    cooldown_seconds=300,
    daily_max_per_phone=20,
)
register_sms_template(
    'workflow_timeout',
    label='审批超时提醒',
    params=('title',),
    sensitive=(),
    cooldown_seconds=300,
    daily_max_per_phone=20,
)
