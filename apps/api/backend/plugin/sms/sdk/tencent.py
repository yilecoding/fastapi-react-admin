"""腾讯云短信（官方 SDK `tencentcloud-sdk-python-sms`，异步客户端，需要 `tencentcloud-sdk-python-common[async]`）。

实测行为（2026-10-24，sms 3.1.153 + common 3.1.193 / httpx 0.28.1，见 issue #153 第一节第 5 条）：

| 情况 | SDK 的表现 | 这里的归类 |
|---|---|---|
| 成功 | 返回，`SendStatusSet[0].Code == 'Ok'` | 已受理 |
| 单号码 / 业务失败 | **不抛**，`SendStatusSet[0].Code` 是错误码 | 按码归类 |
| 接口级错误 | 抛 `TencentCloudSDKException`，`get_code()` | 按码归类 |
| 接口级错误，但响应头是 `application/json; charset=utf-8` | 🔴 **不抛**，返回 `SendStatusSet=None` | 结果未知 |
| HTTP 5xx 非 JSON | 抛 `TencentCloudSDKException(code=ServerNetworkError)` | 结果未知 |
| 连接被拒 / 连接超时 | 抛 **`httpx.ConnectError` / `ConnectTimeout`**（SDK 不包装） | 未发出（基类认） |
| 读超时 | 抛 `httpx.ReadTimeout` | **结果未知** |
| 默认超时 | **60 秒**（`HttpProfile.reqTimeout`） | 显式传配置的 `timeout` |

🔴 **永远不设 `HttpProfile.proxy`**：异步客户端一设就 `TypeError: AsyncClient.__init__() got an unexpected
keyword argument 'proxies'`（SDK 还在用 httpx 0.28 已删除的参数）。代理只走进程环境变量，两家都通。
守卫：`tests/test_sms_guards.py::test_tencent_adapter_never_sets_http_proxy`。
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

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


class TencentConfig(BaseModel):
    """腾讯云短信的配置字段"""

    secret_id: str = Field(min_length=1, title='SecretId')
    secret_key: str = Field(min_length=1, title='SecretKey')
    sdk_app_id: str = Field(min_length=1, title='SdkAppId', description='短信控制台「应用管理」里的 SDKAppID，纯数字')
    region: Literal['ap-guangzhou', 'ap-beijing', 'ap-nanjing'] = Field(
        'ap-guangzhou', title='地域', description='国内短信三个地域任选，不影响发送范围'
    )


#: 错误码 → 分类。码是文档原文；除 `AuthFailure.SecretIdNotFound` 之外都没实际触发过（issue #153）
_EXACT: dict[str, SmsErrorKind] = {
    'LimitExceeded.DeliveryFrequencyLimit': SmsErrorKind.rate_limited,
    'InvalidParameterValue.IncorrectPhoneNumber': SmsErrorKind.invalid_phone,
    'FailedOperation.PhoneNumberParseFail': SmsErrorKind.invalid_phone,
    'FailedOperation.PhoneNumberInBlacklist': SmsErrorKind.invalid_phone,
    'InvalidParameterValue.TemplateParameterLengthLimit': SmsErrorKind.bad_params,
    'InvalidParameterValue.TemplateParameterFormatError': SmsErrorKind.bad_params,
    'InvalidParameterValue.ProhibitedUseUrlInTemplateParameter': SmsErrorKind.bad_params,
    'InvalidParameterValue.ContentLengthLimit': SmsErrorKind.bad_params,
    'FailedOperation.ContainSensitiveWord': SmsErrorKind.bad_params,
    'FailedOperation.SignatureIncorrectOrUnapproved': SmsErrorKind.config_error,
    'FailedOperation.TemplateUnapprovedOrNotExist': SmsErrorKind.config_error,
    'FailedOperation.TemplateIncorrectOrUnapproved': SmsErrorKind.config_error,
    'FailedOperation.TemplateParamSetNotMatchApprovedTemplate': SmsErrorKind.config_error,
    'InvalidParameterValue.SdkAppIdNotExist': SmsErrorKind.config_error,
    'UnauthorizedOperation.SmsSdkAppIdVerifyFail': SmsErrorKind.config_error,
    'UnauthorizedOperation.SdkAppIdIsDisabled': SmsErrorKind.config_error,
    'LimitExceeded.AppDailyLimit': SmsErrorKind.account_error,
    'LimitExceeded.AppMainlandChinaDailyLimit': SmsErrorKind.account_error,
    'FailedOperation.InsufficientBalanceInSmsPackage': SmsErrorKind.account_error,
    'UnauthorizedOperation.ServiceSuspendDueToArrears': SmsErrorKind.account_error,
    'ServerNetworkError': SmsErrorKind.unknown,
}
_PREFIXES: list[tuple[str, SmsErrorKind]] = [
    ('LimitExceeded.PhoneNumber', SmsErrorKind.rate_limited),
    ('AuthFailure', SmsErrorKind.config_error),
    ('InternalError', SmsErrorKind.unknown),
]


def classify_tencent(code: str | None) -> SmsErrorKind:
    return classify_code(code, _EXACT, _PREFIXES)


@register_provider
class TencentSmsProvider(SmsProvider):
    code = 'tencent'
    label = '腾讯云短信'
    Config = TencentConfig
    template_mapping = TemplateMapping.ordered
    credential_fields = ('secret_id', 'secret_key')
    template_id_hint = '模板 ID，纯数字（控制台「正文模板管理」里的）'

    #: 只给契约测试用：指到本地假厂商服务器。配置里**不暴露**
    scheme: ClassVar[str] = 'https'
    endpoint: ClassVar[str | None] = None

    def __init__(
        self, config: BaseModel, *, timeout: float = 10.0, scheme: str | None = None, endpoint: str | None = None
    ) -> None:
        super().__init__(config, timeout=timeout)
        if scheme is not None:
            self.scheme = scheme
        if endpoint is not None:
            self.endpoint = endpoint

    async def _send(self, msg: SmsMessage) -> SmsResult:
        from tencentcloud.common.credential import Credential
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        from tencentcloud.sms.v20210111 import models as sms_models
        from tencentcloud.sms.v20210111.sms_client_async import SmsClient

        cfg: Any = self.config
        # 🔴 这里只传 endpoint / reqTimeout / protocol，**不传 proxy**（见模块 docstring）
        http_profile = HttpProfile(endpoint=self.endpoint, reqTimeout=self.timeout, protocol=self.scheme)
        profile = ClientProfile(httpProfile=http_profile)
        request = sms_models.SendSmsRequest()
        # 文档原文：国内也「支持 0086、86 或无任何国家或地区码的 11 位手机号码」；这里统一 E.164
        request.PhoneNumberSet = [f'+86{msg.phone}']
        request.SmsSdkAppId = cfg.sdk_app_id
        request.TemplateId = msg.template_id
        request.SignName = msg.sign_name
        request.TemplateParamSet = list(msg.params) if not isinstance(msg.params, dict) else list(msg.params.values())
        # 文档原文：「server 会原样返回。注意长度需小于 512 字节」
        request.SessionContext = msg.out_id
        async with SmsClient(Credential(cfg.secret_id, cfg.secret_key), cfg.region, profile) as client:
            response = await client.SendSms(request)

        statuses = getattr(response, 'SendStatusSet', None)
        if not statuses:
            # 🔴 看不到错误码就不能断定没发：`SendStatusSet` 为空 / 缺失一律「结果未知」
            return SmsResult.unknown(
                provider_code=None,
                provider_msg='响应里没有 SendStatusSet（接口级错误被 SDK 吞成了空响应）',
                request_id=getattr(response, 'RequestId', None),
            )
        status = statuses[0]
        code = getattr(status, 'Code', None)
        if code == 'Ok':
            return SmsResult.accepted(
                provider_code='Ok',
                provider_msg=getattr(status, 'Message', None),
                request_id=response.RequestId,
                biz_id=getattr(status, 'SerialNo', None),
            )
        return SmsResult.failed(
            classify_tencent(code),
            provider_code=code,
            provider_msg=getattr(status, 'Message', None),
            request_id=getattr(response, 'RequestId', None),
            biz_id=getattr(status, 'SerialNo', None),
        )

    def _classify(self, exc: Exception) -> SmsErrorKind | None:
        for item in iter_exception_chain(exc):
            if type(item).__name__ == 'TencentCloudSDKException':
                getter = getattr(item, 'get_code', None)
                code = getter() if callable(getter) else getattr(item, 'code', None)
                return classify_tencent(code if isinstance(code, str) else None)
        # httpx 的原始异常交给基类：ConnectError / ConnectTimeout → 未发出；ReadTimeout 等 → 未知
        return None
