"""厂商基类、消息 / 结果 / 错误分类（issue #153 第一节）。

🔴 **这里不许 import `backend.*` / sqlalchemy / redis / fastapi**（`tests/test_sms_guards.py` 守着）。
"""

from __future__ import annotations

import abc
import enum
import inspect
import time

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, ClassVar

from pydantic import BaseModel


class SmsStatus(str, enum.Enum):
    """一次发送的结果状态

    🔴 叫「已受理」不叫「已送达」：阿里云原文「返回 OK 代表请求成功」，计费按运营商回执，
    提交成功不等于用户收到。
    """

    accepted = 'accepted'
    failed = 'failed'
    #: 可能已发出：读超时、5xx、响应里没有状态。**不能当成没发**（会重复发）
    unknown = 'unknown'


class SmsErrorKind(str, enum.Enum):
    """错误分类 —— 日志页按它筛、报警按它判、调用方按它决定 HTTP 状态码"""

    #: 号码被厂商限频；对用户说「太频繁」，冷却位保留
    rate_limited = 'rate_limited'
    #: 号码有问题；用户能自己纠正
    invalid_phone = 'invalid_phone'
    #: 模板参数不合规（使用方的 bug）
    bad_params = 'bad_params'
    #: 凭据 / 签名 / 模板配置错了；要报警
    config_error = 'config_error'
    #: 余额 / 限额 / 账号状态；要报警
    account_error = 'account_error'
    #: 其它明确的厂商错误
    provider_error = 'provider_error'
    #: 连接没建立 —— 确定没发出去
    network_unsent = 'network_unsent'
    #: 连上之后出的任何事 —— 可能已发出
    unknown = 'unknown'


#: 「确定没发出去」的类别：冷却位可以释放。`rate_limited` / `unknown` 不在里面 ——
#: 前者是厂商替我们拦的（再放一次只会再被拦），后者可能已经发出去了。
UNSENT_KINDS: frozenset[SmsErrorKind] = frozenset({
    SmsErrorKind.network_unsent,
    SmsErrorKind.config_error,
    SmsErrorKind.bad_params,
    SmsErrorKind.invalid_phone,
    SmsErrorKind.account_error,
    SmsErrorKind.provider_error,
})


class TemplateMapping(str, enum.Enum):
    """业务模板参数怎么对到厂商模板

    - `named`：按变量名，`{厂商变量名: 业务参数名}`（阿里云式：变量名由模板作者起，不一定叫 `code`）
    - `ordered`：按位置，`[业务参数名, …]`（腾讯云式：「模板参数的个数需要与模板的变量个数保持一致」）
    """

    named = 'named'
    ordered = 'ordered'


@dataclass(frozen=True, slots=True)
class SmsMessage:
    """交给厂商的一条短信（厂商侧的形状，业务模板已经翻译完）"""

    #: 裸 11 位大陆号。要不要加 `+86` 由各家适配器自己决定
    phone: str
    #: 厂商模板 ID（阿里云 `SMS_xxx` / 腾讯云纯数字）
    template_id: str
    #: 厂商侧参数：`named` 是 `{变量名: 值}`，`ordered` 是 `[值, …]`
    params: Mapping[str, str] | Sequence[str]
    sign_name: str
    #: 我们的流水号（日志 id），原样传给厂商（阿里云 `OutId` / 腾讯云 `SessionContext`），在厂商控制台按它能对上
    out_id: str


@dataclass(slots=True)
class SmsResult:
    """厂商返回翻译成的统一结果。**永远不抛原始异常**，看 `status` 和 `error_kind`"""

    status: SmsStatus
    error_kind: SmsErrorKind | None = None
    #: 厂商原始错误码（成功时是 `OK` / `Ok`）
    provider_code: str | None = None
    #: 厂商原始文案；网络类失败放异常类型和文本
    provider_msg: str | None = None
    request_id: str | None = None
    #: 回执 ID（阿里云 `BizId` / 腾讯云 `SerialNo`），查送达状态要用
    biz_id: str | None = None
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        return self.status is SmsStatus.accepted

    @classmethod
    def accepted(
        cls, *, provider_code: str, provider_msg: str | None, request_id: str | None, biz_id: str | None
    ) -> SmsResult:
        return cls(SmsStatus.accepted, None, provider_code, _clip(provider_msg), request_id, biz_id)

    @classmethod
    def failed(
        cls,
        kind: SmsErrorKind,
        *,
        provider_code: str | None,
        provider_msg: str | None,
        request_id: str | None = None,
        biz_id: str | None = None,
    ) -> SmsResult:
        # `unknown` 这一类不是「失败」而是「结果未知」，状态要跟着走，否则冷却位的处理会按失败释放
        status = SmsStatus.unknown if kind is SmsErrorKind.unknown else SmsStatus.failed
        return cls(status, kind, provider_code, _clip(provider_msg), request_id, biz_id)

    @classmethod
    def unknown(
        cls, *, provider_code: str | None, provider_msg: str | None, request_id: str | None = None
    ) -> SmsResult:
        return cls(SmsStatus.unknown, SmsErrorKind.unknown, provider_code, _clip(provider_msg), request_id, None)


def _clip(text: str | None, limit: int = 1000) -> str | None:
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + '…'


# ─── 异常归类 ──────────────────────────────────────────────────────────────────

#: 「连接没建立」的异常。**按类名认而不是 import 它们**：httpx / aiohttp 是厂商 SDK 的依赖，
#: 这一层自己不依赖它们；而且按 MRO 名字判，`ClientConnectorDNSError` 这类子类也一并算进去。
#:
#: ⚠️ aiohttp 的 `ConnectionTimeoutError` 和 `SocketTimeoutError` **都是 `ServerTimeoutError` 的子类**
#: （实测），所以这里只认前者的名字，绝不认父类 —— 按父类判会把「读超时（可能已发出）」
#: 误判成「没发出去」，然后重复发。
_UNSENT_EXCEPTION_NAMES: frozenset[str] = frozenset({
    # httpx（腾讯云 SDK 原样往外抛）
    'ConnectError',
    'ConnectTimeout',
    # aiohttp（阿里云 SDK 包在 UnretryableException → RetryError → inner_exception 链里）
    'ClientConnectorError',
    'ConnectionTimeoutError',
})


def iter_exception_chain(exc: BaseException, limit: int = 12) -> Iterator[BaseException]:
    """沿 `inner_exception` / `__cause__` / `__context__` 往里走，去重、限深"""
    seen: set[int] = set()
    stack: list[BaseException] = [exc]
    while stack and len(seen) < limit:
        current = stack.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        for attr in ('inner_exception', '__cause__', '__context__'):
            nxt = getattr(current, attr, None)
            if isinstance(nxt, BaseException):
                stack.append(nxt)


def is_connection_never_established(exc: BaseException) -> bool:
    """这个异常（或它链上的某一层）是不是「TCP 连接根本没建立」"""
    for item in iter_exception_chain(exc):
        if any(klass.__name__ in _UNSENT_EXCEPTION_NAMES for klass in type(item).__mro__):
            return True
    return False


def classify_code(
    code: str | None, exact: Mapping[str, SmsErrorKind], prefixes: Sequence[tuple[str, SmsErrorKind]]
) -> SmsErrorKind:
    """按厂商错误码归类：先精确、再前缀，都没命中就是 `provider_error`"""
    if not code:
        return SmsErrorKind.unknown
    if code in exact:
        return exact[code]
    for prefix, kind in prefixes:
        if code.startswith(prefix):
            return kind
    return SmsErrorKind.provider_error


# ─── 模板参数映射 ──────────────────────────────────────────────────────────────


def validate_template_mapping(
    kind: TemplateMapping, mapping: Any, declared_params: Sequence[str]
) -> dict[str, str] | list[str]:
    """校验一条模板映射的形状，并归一化（去空白）

    允许只引用一部分声明过的参数（阿里云原文「验证码模板仅支持一个验证码作为变量」），
    但引用的每一个都必须是声明过的 —— 写错的参数名要在保存时就 400，不能等到发送时才失败。

    :raises ValueError: 形状不对 / 引用了没声明的参数
    """
    declared = set(declared_params)
    if kind is TemplateMapping.named:
        if not isinstance(mapping, Mapping) or not mapping:
            raise ValueError('按变量名映射要写成 {"厂商变量名": "业务参数名"}，且至少一项')
        result: dict[str, str] = {}
        for var, param in mapping.items():
            var_s, param_s = str(var).strip(), str(param).strip()
            if not var_s or not param_s:
                raise ValueError('变量名和业务参数名都不能为空')
            if param_s not in declared:
                raise ValueError(f'业务参数 {param_s} 没有在模板里声明（可用：{", ".join(sorted(declared))}）')
            result[var_s] = param_s
        return result
    if not isinstance(mapping, Sequence) or isinstance(mapping, str | bytes) or not mapping:
        raise ValueError('按位置映射要写成 ["业务参数名", …]，且至少一项')
    ordered: list[str] = []
    for param in mapping:
        param_s = str(param).strip()
        if param_s not in declared:
            raise ValueError(f'业务参数 {param_s} 没有在模板里声明（可用：{", ".join(sorted(declared))}）')
        ordered.append(param_s)
    return ordered


def render_template_params(
    kind: TemplateMapping, mapping: Mapping[str, str] | Sequence[str], params: Mapping[str, str]
) -> dict[str, str] | list[str]:
    """把业务参数按映射翻译成厂商侧参数"""
    if kind is TemplateMapping.named:
        assert isinstance(mapping, Mapping)
        return {var: str(params[param]) for var, param in mapping.items()}
    return [str(params[param]) for param in mapping]


# ─── 厂商基类 ──────────────────────────────────────────────────────────────────


class SmsProvider(abc.ABC):
    """继承它就能接一家第三方。

    子类只实现 `_send()`（调厂商、把返回翻译成 `SmsResult`），可选实现 `_classify()`
    （这家 SDK 特有的异常怎么归类）。基类的 `send()` 是模板方法：计时、兜住一切异常、
    **保证永远返回 `SmsResult`、永远不抛原始异常** —— 第三方实现写得再糙，也破不了
    「成败可见、结果可归类」这条契约。
    """

    #: 厂商码，配置表 `provider` 列存的就是它；全局唯一
    code: ClassVar[str]
    #: 给人看的名字
    label: ClassVar[str]
    #: 这家要哪些配置字段（pydantic）：凭据 + 厂商独有选项都在这里，`credential_fields` 指出哪两个是凭据
    Config: ClassVar[type[BaseModel]]
    #: 模板参数按名还是按位置对
    template_mapping: ClassVar[TemplateMapping]
    #: `(key 字段名, secret 字段名)`；`None` = 这家不要凭据（控制台）。secret 那个字段**加密落库、响应只给掩码**
    credential_fields: ClassVar[tuple[str, str] | None] = None
    #: 配置页上「厂商模板 ID」输入框的提示
    template_id_hint: ClassVar[str] = ''

    def __init__(self, config: BaseModel, *, timeout: float = 10.0) -> None:
        if not isinstance(config, self.Config):
            raise TypeError(f'{type(self).__name__} 要的是 {self.Config.__name__}，收到 {type(config).__name__}')
        self.config = config
        # 🔴 必须显式传给 SDK：腾讯云默认等 60 秒（实测）
        self.timeout = float(timeout)

    async def send(self, msg: SmsMessage) -> SmsResult:
        """发一条。永远返回结果，不抛"""
        started = time.perf_counter()
        try:
            result = await self._send(msg)
        except Exception as exc:
            result = self._result_from_exception(exc)
        result.duration_ms = int((time.perf_counter() - started) * 1000)
        return result

    @abc.abstractmethod
    async def _send(self, msg: SmsMessage) -> SmsResult:
        """调厂商。业务失败（HTTP 200 + 错误码）要自己翻成 `SmsResult.failed`，异常可以直接抛，基类接"""

    def _classify(self, exc: Exception) -> SmsErrorKind | None:
        """这家 SDK 特有的异常怎么归类。返回 None 走基类默认（连接没建立 → 未发出，其它 → 未知）"""
        return None

    def _result_from_exception(self, exc: Exception) -> SmsResult:
        kind = self._classify(exc)
        if kind is None:
            # 宁可多等一次冷却，不可把可能已发出的判成没发出
            kind = SmsErrorKind.network_unsent if is_connection_never_established(exc) else SmsErrorKind.unknown
        return SmsResult.failed(
            kind,
            provider_code=getattr(exc, 'code', None) if isinstance(getattr(exc, 'code', None), str) else None,
            provider_msg=f'{type(exc).__name__}: {exc}',
            request_id=_request_id_of(exc),
        )

    @classmethod
    def validate_class(cls) -> None:
        """注册时的形状检查：不合格**启动时就报错**，不等到发送"""
        code = getattr(cls, 'code', None)
        if not isinstance(code, str) or not code or not code.replace('_', '').isalnum() or code != code.lower():
            raise TypeError(f'{cls.__name__}.code 必须是非空的小写字母 / 数字 / 下划线，收到 {code!r}')
        if not isinstance(getattr(cls, 'label', None), str) or not cls.label:
            raise TypeError(f'{cls.__name__}.label 必须是非空字符串')
        config = getattr(cls, 'Config', None)
        if not (inspect.isclass(config) and issubclass(config, BaseModel)):
            raise TypeError(f'{cls.__name__}.Config 必须是 pydantic BaseModel 的子类')
        if not isinstance(getattr(cls, 'template_mapping', None), TemplateMapping):
            raise TypeError(f'{cls.__name__}.template_mapping 必须是 TemplateMapping')
        if not inspect.iscoroutinefunction(cls._send):
            raise TypeError(f'{cls.__name__}._send 必须是 async def')
        creds = cls.credential_fields
        if creds is not None:
            if not (isinstance(creds, tuple) and len(creds) == 2 and all(isinstance(f, str) for f in creds)):
                raise TypeError(f'{cls.__name__}.credential_fields 必须是 (key 字段, secret 字段) 或 None')
            missing = [f for f in creds if f not in config.model_fields]
            if missing:
                raise TypeError(f'{cls.__name__}.credential_fields 指向了 Config 里不存在的字段：{missing}')


def _request_id_of(exc: BaseException) -> str | None:
    for item in iter_exception_chain(exc):
        getter = getattr(item, 'get_request_id', None)
        if callable(getter):
            value = getter()
            if value:
                return str(value)
        value = getattr(item, 'request_id', None)
        if isinstance(value, str) and value:
            return value
    return None
