from backend.common.exception import errors
from backend.common.response.response_code import StandardResponseCode
from backend.plugin.sms.sdk.base import SmsErrorKind, SmsResult

#: 用户能自己纠正的两类 → 400；其余是我们 / 厂商这边的事 → 502
_CLIENT_SIDE: frozenset[str] = frozenset({SmsErrorKind.invalid_phone.value, SmsErrorKind.rate_limited.value})


class SmsSendError(errors.BaseExceptionError):
    """`sms_service.send()` 失败时抛的唯一一种异常

    🔴 硬纪律 9：失败必须是可见状态。邮件插件 #64 修过同款（吞掉异常后返回成功，客户端 200 却收不到）。
    `kind` 是 `SmsErrorKind` 的取值，或 `enums.CIRCUIT_OPEN`；`result` 是厂商那一侧的原始结果（被我们
    自己拦下时为 None）；`log_id` 是这次发送的日志 id（没走到落日志那一步时为 None）。
    """

    def __init__(self, *, kind: str, msg: str, result: SmsResult | None = None, log_id: int | None = None) -> None:
        self.kind = kind
        self.result = result
        self.log_id = log_id
        self.code = StandardResponseCode.HTTP_400 if kind in _CLIENT_SIDE else StandardResponseCode.HTTP_502
        data = {'kind': kind}
        if result is not None:
            data |= {'provider_code': result.provider_code, 'request_id': result.request_id}
        if log_id is not None:
            data['log_id'] = str(log_id)
        super().__init__(msg=msg, data=data)
