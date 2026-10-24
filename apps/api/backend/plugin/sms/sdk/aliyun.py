"""阿里云短信（官方 SDK `alibabacloud-dysmsapi20170525`，异步接口）。

实测行为（2026-10-24，SDK 4.6.0 / aiohttp 3.14，见 issue #153 第一节第 5 条）：

| 情况 | SDK 的表现 | 这里的归类 |
|---|---|---|
| 成功 | 返回，`body.code == 'OK'` | 已受理 |
| 单号码 / 业务失败 | **不抛**，HTTP 200，`body.code` 是错误码 | 按码归类 |
| HTTP 4xx | 抛 `ClientException`，`.code` | 按码归类 |
| HTTP 5xx 非 JSON | 抛 `UnretryableException`（JSON 解析失败） | 结果未知 |
| 连接被拒 / 连接超时 | `UnretryableException` → `RetryError` → aiohttp 连接异常 | 未发出（基类沿链认） |
| 读超时 | 同上链路 → `SocketTimeoutError` | **结果未知** |

🔴 凭据永远显式传：没给 AK 时凭据库会走默认凭据链，ECS 角色凭据会起一个 apscheduler 后台线程。
🔴 代理只走进程环境变量（`HTTP_PROXY` / `HTTPS_PROXY`），配置里不做代理字段。
"""

from __future__ import annotations

import json

from typing import Any, ClassVar

from pydantic import BaseModel, Field, field_validator

from backend.plugin.sms.sdk.base import (
    SmsErrorKind,
    SmsMessage,
    SmsProvider,
    SmsResult,
    TemplateMapping,
    classify_code,
    iter_exception_chain,
)
from backend.plugin.sms.sdk.registry import register_provider


class AliyunConfig(BaseModel):
    """阿里云短信的配置字段"""

    access_key_id: str = Field(min_length=1, title='AccessKey ID')
    access_key_secret: str = Field(min_length=1, title='AccessKey Secret')
    endpoint: str = Field(
        'dysmsapi.aliyuncs.com',
        title='接入点',
        description=(
            '只填主机名（不带 https://）。默认 dysmsapi.aliyuncs.com；'
            'VPC 内可用 dysmsapi-vpc.cn-hangzhou.aliyuncs.com 这类地域接入点'
        ),
    )

    @field_validator('endpoint')
    @classmethod
    def check_endpoint(cls, v: str) -> str:
        v = v.strip()
        if not v:
            return 'dysmsapi.aliyuncs.com'
        if '://' in v or '/' in v:
            raise ValueError('接入点只填主机名，不带协议和路径')
        return v


#: 错误码 → 分类。码是文档原文；除 `InvalidAccessKeyId.NotFound` / `InvalidCredentials` 之外都没实际触发过（issue #153）
_EXACT: dict[str, SmsErrorKind] = {
    # 限频
    'isv.BUSINESS_LIMIT_CONTROL': SmsErrorKind.rate_limited,
    'isv.MOBILE_SEND_LIMIT': SmsErrorKind.rate_limited,
    # 号码
    'isv.MOBILE_NUMBER_ILLEGAL': SmsErrorKind.invalid_phone,
    # 参数
    'isv.PARAM_LENGTH_LIMIT': SmsErrorKind.bad_params,
    'isv.INVALID_JSON_PARAM': SmsErrorKind.bad_params,
    'isv.PARAM_NOT_SUPPORT_URL': SmsErrorKind.bad_params,
    'isv.UNSUPPORTED_CONTENT': SmsErrorKind.bad_params,
    'isv.SMS_CONTENT_ILLEGAL': SmsErrorKind.bad_params,
    # 配置
    'InvalidAccessKeyId.NotFound': SmsErrorKind.config_error,
    'SignatureDoesNotMatch': SmsErrorKind.config_error,
    'InvalidCredentials': SmsErrorKind.config_error,
    'isp.RAM_PERMISSION_DENY': SmsErrorKind.config_error,
    'isv.SMS_SIGNATURE_ILLEGAL': SmsErrorKind.config_error,
    'isv.SIGN_STATE_ILLEGAL': SmsErrorKind.config_error,
    'isv.SMS_SIGNATURE_SCENE_ILLEGAL': SmsErrorKind.config_error,
    'isv.SMS_TEMPLATE_ILLEGAL': SmsErrorKind.config_error,
    'isv.TEMPLATE_MISSING_PARAMETERS': SmsErrorKind.config_error,
    'isv.SMS_TEST_NUMBER_LIMIT': SmsErrorKind.config_error,
    'isv.DENY_IP_RANGE': SmsErrorKind.config_error,
    # 账号
    'isv.DAY_LIMIT_CONTROL': SmsErrorKind.account_error,
    'isv.MONTH_LIMIT_CONTROL': SmsErrorKind.account_error,
    'isv.AMOUNT_NOT_ENOUGH': SmsErrorKind.account_error,
    'isv.OUT_OF_SERVICE': SmsErrorKind.account_error,
    'isv.ACCOUNT_ABNORMAL': SmsErrorKind.account_error,
    'isv.ACCOUNT_NOT_EXISTS': SmsErrorKind.account_error,
    'isv.SECURITY_FROZEN_ACCOUNT': SmsErrorKind.account_error,
    'isv.PRODUCT_UN_SUBSCRIPT': SmsErrorKind.account_error,
}
_PREFIXES: list[tuple[str, SmsErrorKind]] = [
    ('InvalidAccessKeyId', SmsErrorKind.config_error),
    ('Forbidden', SmsErrorKind.config_error),
    # 接口级 QPS 限流是账号层面的事（不是某个号码），要报警
    ('Throttling', SmsErrorKind.account_error),
    # 阿里云服务端自己的错 —— 可能已经处理了请求
    ('InternalError', SmsErrorKind.unknown),
    ('ServiceUnavailable', SmsErrorKind.unknown),
]


def classify_aliyun(code: str | None) -> SmsErrorKind:
    return classify_code(code, _EXACT, _PREFIXES)


@register_provider
class AliyunSmsProvider(SmsProvider):
    code = 'aliyun'
    label = '阿里云短信'
    Config = AliyunConfig
    template_mapping = TemplateMapping.named
    credential_fields = ('access_key_id', 'access_key_secret')
    template_id_hint = '模板 CODE，形如 SMS_123456789（控制台「模板管理」里的）'

    #: 只给契约测试用：指到本地假厂商服务器。配置里**不暴露** http
    scheme: ClassVar[str] = 'https'

    def __init__(self, config: BaseModel, *, timeout: float = 10.0, scheme: str | None = None) -> None:
        super().__init__(config, timeout=timeout)
        if scheme is not None:
            self.scheme = scheme

    async def _send(self, msg: SmsMessage) -> SmsResult:
        # 懒 import：装了插件但没装依赖时，启动不炸，发送那一刻报 ImportError（基类接成 unknown 并带原文）
        from alibabacloud_dysmsapi20170525 import models as sms_models
        from alibabacloud_dysmsapi20170525.client import Client
        from alibabacloud_tea_openapi import models as openapi_models
        from alibabacloud_tea_util import models as util_models

        cfg: Any = self.config
        timeout_ms = int(self.timeout * 1000)
        client = Client(
            openapi_models.Config(
                # 🔴 显式传凭据，不走默认凭据链
                access_key_id=cfg.access_key_id,
                access_key_secret=cfg.access_key_secret,
                endpoint=cfg.endpoint,
                protocol=self.scheme.upper(),
                connect_timeout=timeout_ms,
                read_timeout=timeout_ms,
            )
        )
        params = msg.params if isinstance(msg.params, dict) else dict(msg.params)  # type: ignore[arg-type]
        request = sms_models.SendSmsRequest(
            phone_numbers=msg.phone,
            sign_name=msg.sign_name,
            template_code=msg.template_id,
            template_param=json.dumps(params, ensure_ascii=False),
            out_id=msg.out_id,
        )
        # 🔴 不重试：阿里云不支持幂等，超时后重试就是重复发
        runtime = util_models.RuntimeOptions(autoretry=False, connect_timeout=timeout_ms, read_timeout=timeout_ms)
        response = await client.send_sms_with_options_async(request, runtime)
        body = response.body
        code = getattr(body, 'code', None)
        if code == 'OK':
            return SmsResult.accepted(
                provider_code='OK', provider_msg=body.message, request_id=body.request_id, biz_id=body.biz_id
            )
        # 🔴 成败读业务码，不看「有没有抛异常」：单号码失败是 HTTP 200 正常返回
        return SmsResult.failed(
            classify_aliyun(code),
            provider_code=code,
            provider_msg=getattr(body, 'message', None),
            request_id=getattr(body, 'request_id', None),
            biz_id=getattr(body, 'biz_id', None),
        )

    def _classify(self, exc: Exception) -> SmsErrorKind | None:
        for item in iter_exception_chain(exc):
            name = type(item).__name__
            if name == 'ServerException':
                # 5xx 带 JSON：服务端的错，请求可能已经被处理
                return SmsErrorKind.unknown
            if name in {'ClientException', 'ThrottlingException', 'AlibabaCloudException'}:
                code = getattr(item, 'code', None)
                if isinstance(code, str) and code:
                    return classify_aliyun(code)
        # UnretryableException（5xx 非 JSON / 网络）交给基类：连接没建立 → 未发出，其它 → 未知
        return None
