"""控制台厂商：不真发，写日志，结果固定为「已受理」。本地开发、CI、E2E 用它。

🔴 生产环境不注册（`registry.load_builtin_providers(include_console=False)`）。
"""

from __future__ import annotations

import logging
import uuid

from pydantic import BaseModel

from backend.plugin.sms.sdk.base import SmsMessage, SmsProvider, SmsResult, TemplateMapping
from backend.plugin.sms.sdk.registry import register_provider

# 用标准库 logging：这一层不 import `backend.common.log`。应用启动后 loguru 的 InterceptHandler
# 会把它接走，所以在 uvicorn 的窗格里照样看得见
_log = logging.getLogger('sms.console')


class ConsoleConfig(BaseModel):
    """控制台厂商没有任何配置"""


@register_provider
class ConsoleSmsProvider(SmsProvider):
    code = 'console'
    label = '控制台（不真发，开发 / 测试用）'
    Config = ConsoleConfig
    template_mapping = TemplateMapping.named
    credential_fields = None
    template_id_hint = '随便填一个，比如 DEV_CAPTCHA；内容只打进服务端日志'

    async def _send(self, msg: SmsMessage) -> SmsResult:
        params = list(msg.params) if isinstance(msg.params, list | tuple) else dict(msg.params)
        # 回显里的号码也打码：这段文案会原样进 `sms_log.provider_msg`，而列表接口对号码是掩码的 ——
        # 文案里留着完整号等于掩码白做
        masked_phone = f'{msg.phone[:3]}****{msg.phone[-4:]}' if len(msg.phone) >= 7 else '*' * len(msg.phone)
        text = f'[{msg.sign_name}] 模板 {msg.template_id} → {masked_phone} 参数 {params} 流水号 {msg.out_id}'
        _log.info('短信（控制台厂商，未真发）%s → %s', text, msg.phone)
        return SmsResult.accepted(
            provider_code='OK',
            provider_msg=text,
            request_id=f'console-{uuid.uuid4().hex[:16]}',
            biz_id=msg.out_id,
        )
