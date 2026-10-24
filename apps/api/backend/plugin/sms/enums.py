from backend.common.enums import IntEnum, StrEnum


class SmsLogStatus(IntEnum):
    """`sms_log.status`

    🔴 `accepted` 叫「已受理」不叫「已送达」：阿里云原文「返回 OK 代表请求成功」，计费按运营商回执，
    提交成功不等于用户收到。`sending` 是两段式日志的第一段；进程在两步之间崩溃会停在这里，
    日志页按 `SMS_SENDING_STALE_SECONDS` 把它显示成「结果未知」。
    """

    failed = 0
    accepted = 1
    unknown = 2
    sending = 3


class SmsGuardVerdict(StrEnum):
    """Redis 防刷脚本的判定（`service/guard.py`）"""

    ok = 'ok'
    #: 同一号码同一模板还在冷却期
    cooldown = 'cooldown'
    #: 同一号码同一模板今天到上限了
    phone_daily = 'phone_daily'
    #: 全站本小时到上限了（防使用方写错循环把余额刷光）
    circuit = 'circuit'


#: 被全站熔断拦下时 `SmsSendError.kind` 的取值。不在 SDK 的 `SmsErrorKind` 里 —— 它不是厂商的结果，
#: 而且被我们自己拦下的请求**不写 `sms_log`**（否则刷接口就是刷日志表）
CIRCUIT_OPEN = 'circuit_open'
