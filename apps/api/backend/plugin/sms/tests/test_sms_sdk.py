"""SDK 行为契约（issue #153 第一节第 5 条的行为矩阵做成测试）。

起本地假厂商服务器，**用真 SDK**打它，逐行断言归类结果。SDK 升级改了行为（腾讯云修了 `proxies`、
改了异常包装…）时这组测试先红，而不是线上先错。纯 Python：不碰数据库、不碰 Redis、不起 FastAPI。
"""

from __future__ import annotations

import asyncio
import socket

from typing import TYPE_CHECKING, Any

import pytest

from backend.plugin.sms.sdk.aliyun import AliyunConfig, AliyunSmsProvider
from backend.plugin.sms.sdk.base import (
    SmsErrorKind,
    SmsMessage,
    SmsProvider,
    SmsResult,
    SmsStatus,
    TemplateMapping,
    is_connection_never_established,
    render_template_params,
    validate_template_mapping,
)
from backend.plugin.sms.sdk.console import ConsoleConfig, ConsoleSmsProvider
from backend.plugin.sms.sdk.tencent import TencentConfig, TencentSmsProvider
from backend.plugin.sms.tests.fake_provider import FakeProvider

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

MSG = SmsMessage(phone='13800000000', template_id='SMS_1', params={'code': '1234'}, sign_name='测试', out_id='1')
MSG_ORDERED = SmsMessage(phone='13800000000', template_id='100', params=['1234', '5'], sign_name='测试', out_id='1')


def _run(coro: Any) -> Any:
    # 纯 SDK 测试，不和 TestClient 共享事件循环，asyncio.run 在这里是安全的
    return asyncio.run(coro)


def run_with(server: FakeProvider, body: Callable[[], Awaitable[Any]]) -> Any:
    """🔴 假服务器和 SDK 客户端必须跑在**同一个**事件循环里。

    第一版在 fixture 里 `asyncio.run(server.start())`、测试里再 `asyncio.run(provider.send())`：
    服务器的监听 socket 绑在一个已经关掉的循环上，连接能建立、请求永远读不到 —— 阿里云那边报
    「Timeout on reading data from socket」，看起来像 SDK 的读超时归类有问题，其实是测试夹具坏了。
    """

    async def main() -> Any:
        await server.start()
        try:
            return await body()
        finally:
            await server.stop()

    return asyncio.run(main())


@pytest.fixture
def aliyun_server() -> FakeProvider:
    return FakeProvider('aliyun')


@pytest.fixture
def tencent_server() -> FakeProvider:
    return FakeProvider('tencent')


def _aliyun(server: FakeProvider, timeout: float = 3.0) -> AliyunSmsProvider:
    cfg = AliyunConfig(access_key_id='LTAI-test', access_key_secret='secret', endpoint=server.endpoint)
    return AliyunSmsProvider(cfg, timeout=timeout, scheme='http')


def _tencent(server: FakeProvider, timeout: float = 3.0) -> TencentSmsProvider:
    cfg = TencentConfig(secret_id='AKID-test', secret_key='secret', sdk_app_id='1400000000')
    return TencentSmsProvider(cfg, timeout=timeout, scheme='http', endpoint=server.endpoint)


def _free_closed_port() -> int:
    """拿一个刚被释放的端口：连它会被拒"""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class TestAliyunContract:
    def test_success_reads_business_code(self, aliyun_server: FakeProvider) -> None:
        result = run_with(aliyun_server, lambda: _aliyun(aliyun_server).send(MSG))
        assert result.ok and result.status is SmsStatus.accepted
        assert result.biz_id == 'BIZ-0001' and result.request_id == 'ALI-REQ-0001'
        # 流水号 / 模板参数真的进了请求（RPC 风格：参数在查询串里，不在表单体里）
        query = aliyun_server.requests[0]['query']
        assert query['OutId'] == '1' and query['TemplateCode'] == 'SMS_1' and query['PhoneNumbers'] == '13800000000'
        assert query['TemplateParam'] == '{"code": "1234"}'

    @pytest.mark.parametrize(
        ('code', 'kind'),
        [
            ('isv.MOBILE_NUMBER_ILLEGAL', SmsErrorKind.invalid_phone),
            ('isv.BUSINESS_LIMIT_CONTROL', SmsErrorKind.rate_limited),
            ('isv.SMS_TEMPLATE_ILLEGAL', SmsErrorKind.config_error),
            ('isv.AMOUNT_NOT_ENOUGH', SmsErrorKind.account_error),
            ('isv.PARAM_LENGTH_LIMIT', SmsErrorKind.bad_params),
            ('isv.SOMETHING_NEW', SmsErrorKind.provider_error),
        ],
    )
    def test_business_failure_is_http_200_and_classified(
        self, aliyun_server: FakeProvider, code: str, kind: SmsErrorKind
    ) -> None:
        """🔴 单号码失败是**正常返回**（HTTP 200 + 错误码），不抛 —— 看「有没有抛异常」会把失败当成功"""
        aliyun_server.mode, aliyun_server.code = 'biz_fail', code
        result = run_with(aliyun_server, lambda: _aliyun(aliyun_server).send(MSG))
        assert result.status is SmsStatus.failed and result.error_kind is kind
        assert result.provider_code == code and result.request_id == 'ALI-REQ-0001'

    def test_api_level_error_is_classified_by_code(self, aliyun_server: FakeProvider) -> None:
        aliyun_server.mode, aliyun_server.code = 'api_error', 'InvalidAccessKeyId.NotFound'
        result = run_with(aliyun_server, lambda: _aliyun(aliyun_server).send(MSG))
        assert result.status is SmsStatus.failed and result.error_kind is SmsErrorKind.config_error
        assert result.provider_code == 'InvalidAccessKeyId.NotFound'

    def test_5xx_non_json_is_unknown(self, aliyun_server: FakeProvider) -> None:
        aliyun_server.mode = 'server_5xx_html'
        result = run_with(aliyun_server, lambda: _aliyun(aliyun_server).send(MSG))
        assert result.status is SmsStatus.unknown and result.error_kind is SmsErrorKind.unknown

    def test_connection_refused_is_unsent(self) -> None:
        cfg = AliyunConfig(access_key_id='k', access_key_secret='s', endpoint=f'127.0.0.1:{_free_closed_port()}')
        result = _run(AliyunSmsProvider(cfg, timeout=3, scheme='http').send(MSG))
        assert result.status is SmsStatus.failed and result.error_kind is SmsErrorKind.network_unsent

    def test_read_timeout_is_unknown_not_unsent(self, aliyun_server: FakeProvider) -> None:
        """🔴 连上之后的超时可能已经发出去了：归「未知」，绝不能归「未发出」（会重复发）"""
        aliyun_server.mode = 'hang'
        result = run_with(aliyun_server, lambda: _aliyun(aliyun_server, timeout=1).send(MSG))
        assert result.status is SmsStatus.unknown and result.error_kind is SmsErrorKind.unknown
        assert len(aliyun_server.requests) == 1, '不重试：假服务器应该只收到 1 次请求'

    def test_no_retry_on_business_failure(self, aliyun_server: FakeProvider) -> None:
        aliyun_server.mode, aliyun_server.code = 'biz_fail', 'isv.BUSINESS_LIMIT_CONTROL'
        run_with(aliyun_server, lambda: _aliyun(aliyun_server).send(MSG))
        assert len(aliyun_server.requests) == 1


class TestTencentContract:
    def test_success_reads_send_status_code(self, tencent_server: FakeProvider) -> None:
        result = run_with(tencent_server, lambda: _tencent(tencent_server).send(MSG_ORDERED))
        assert result.ok and result.biz_id == 'SERIAL-0001' and result.request_id == 'TC-REQ-0001'
        body = tencent_server.requests[0]['body']
        assert '"+8613800000000"' in body and '"SessionContext": "1"' in body.replace('":"', '": "')
        assert tencent_server.requests[0]['headers'].get('X-TC-Action') == 'SendSms'

    @pytest.mark.parametrize(
        ('code', 'kind'),
        [
            ('LimitExceeded.PhoneNumberThirtySecondLimit', SmsErrorKind.rate_limited),
            ('LimitExceeded.PhoneNumberDailyLimit', SmsErrorKind.rate_limited),
            ('InvalidParameterValue.IncorrectPhoneNumber', SmsErrorKind.invalid_phone),
            ('FailedOperation.TemplateUnapprovedOrNotExist', SmsErrorKind.config_error),
            ('LimitExceeded.AppDailyLimit', SmsErrorKind.account_error),
            ('FailedOperation.ContainSensitiveWord', SmsErrorKind.bad_params),
            ('FailedOperation.SomethingElse', SmsErrorKind.provider_error),
        ],
    )
    def test_business_failure_is_in_send_status_set(
        self, tencent_server: FakeProvider, code: str, kind: SmsErrorKind
    ) -> None:
        tencent_server.mode, tencent_server.code = 'biz_fail', code
        result = run_with(tencent_server, lambda: _tencent(tencent_server).send(MSG_ORDERED))
        assert result.status is SmsStatus.failed and result.error_kind is kind and result.provider_code == code

    def test_api_level_error_raises_and_is_classified(self, tencent_server: FakeProvider) -> None:
        tencent_server.mode, tencent_server.code = 'api_error', 'AuthFailure.SecretIdNotFound'
        result = run_with(tencent_server, lambda: _tencent(tencent_server).send(MSG_ORDERED))
        assert result.status is SmsStatus.failed and result.error_kind is SmsErrorKind.config_error
        assert result.provider_code == 'AuthFailure.SecretIdNotFound'

    def test_api_error_with_charset_header_is_unknown_not_success(self, tencent_server: FakeProvider) -> None:
        """🔴 响应头带 `charset` 时 SDK 把接口级错误吞成 `SendStatusSet=None`。看不到错误码就不能断定没发"""
        tencent_server.mode, tencent_server.code = 'api_error_charset', 'AuthFailure.SecretIdNotFound'
        result = run_with(tencent_server, lambda: _tencent(tencent_server).send(MSG_ORDERED))
        assert not result.ok, '接口级错误被当成了成功'
        assert result.status is SmsStatus.unknown and result.error_kind is SmsErrorKind.unknown
        assert result.request_id == 'TC-REQ-0001'

    def test_5xx_non_json_is_unknown(self, tencent_server: FakeProvider) -> None:
        tencent_server.mode = 'server_5xx_html'
        result = run_with(tencent_server, lambda: _tencent(tencent_server).send(MSG_ORDERED))
        assert result.status is SmsStatus.unknown and result.error_kind is SmsErrorKind.unknown
        assert result.provider_code == 'ServerNetworkError'

    def test_connection_refused_is_unsent(self) -> None:
        cfg = TencentConfig(secret_id='k', secret_key='s', sdk_app_id='1')
        result = _run(
            TencentSmsProvider(cfg, timeout=3, scheme='http', endpoint=f'127.0.0.1:{_free_closed_port()}').send(
                MSG_ORDERED
            )
        )
        assert result.status is SmsStatus.failed and result.error_kind is SmsErrorKind.network_unsent

    def test_read_timeout_is_unknown_and_timeout_is_honoured(self, tencent_server: FakeProvider) -> None:
        """默认超时是 60 秒；配置的 timeout 必须真的传给了 SDK（1 秒内回来）"""
        tencent_server.mode = 'hang'
        import time

        async def timed() -> tuple[SmsResult, float]:
            started = time.perf_counter()
            result = await _tencent(tencent_server, timeout=1).send(MSG_ORDERED)
            return result, time.perf_counter() - started

        result, elapsed = run_with(tencent_server, timed)
        assert elapsed < 5, f'配置的 timeout 没传给 SDK：等了 {elapsed:.1f}s（假服务器要 8 秒才答）'
        assert result.status is SmsStatus.unknown and result.error_kind is SmsErrorKind.unknown
        assert len(tencent_server.requests) == 1, '不重试'


class TestBaseContract:
    """基类：子类 `_send()` 抛任意异常，`send()` 都返回 `SmsResult` 不外抛；未识别的异常归 `unknown`"""

    def test_arbitrary_exception_becomes_unknown_result(self) -> None:
        class Broken(SmsProvider):
            code, label, Config, template_mapping = 'broken', '坏的', ConsoleConfig, TemplateMapping.named

            async def _send(self, msg: SmsMessage) -> SmsResult:
                raise RuntimeError('boom')

        result = _run(Broken(ConsoleConfig()).send(MSG))
        assert result.status is SmsStatus.unknown and result.error_kind is SmsErrorKind.unknown
        assert 'RuntimeError: boom' in (result.provider_msg or '')

    def test_console_provider_accepts_and_echoes(self) -> None:
        result = _run(ConsoleSmsProvider(ConsoleConfig()).send(MSG))
        assert result.ok and result.biz_id == '1' and '138****0000' in (result.provider_msg or '')

    def test_wrong_config_type_is_rejected_at_construction(self) -> None:
        with pytest.raises(TypeError):
            AliyunSmsProvider(ConsoleConfig())

    def test_timeout_subclass_ordering_for_aiohttp(self) -> None:
        """⚠️ aiohttp 的 ConnectionTimeoutError / SocketTimeoutError 都是 ServerTimeoutError 的子类：只有前者算未发出"""
        import aiohttp

        assert issubclass(aiohttp.ConnectionTimeoutError, aiohttp.ServerTimeoutError)
        assert issubclass(aiohttp.SocketTimeoutError, aiohttp.ServerTimeoutError)
        assert is_connection_never_established(aiohttp.ConnectionTimeoutError('x'))
        assert not is_connection_never_established(aiohttp.SocketTimeoutError('x'))
        assert not is_connection_never_established(aiohttp.ServerTimeoutError('x'))

    def test_httpx_exception_ordering(self) -> None:
        import httpx

        assert is_connection_never_established(httpx.ConnectError('x'))
        assert is_connection_never_established(httpx.ConnectTimeout('x'))
        assert not is_connection_never_established(httpx.ReadTimeout('x'))

    def test_wrapped_exception_chain_is_followed(self) -> None:
        import aiohttp

        inner = aiohttp.ClientConnectorDNSError(None, OSError('dns'))  # type: ignore[arg-type]
        outer = RuntimeError('wrapped')
        outer.inner_exception = inner  # type: ignore[attr-defined]
        assert is_connection_never_established(outer)


class TestTemplateMapping:
    def test_named_mapping_validates_and_renders(self) -> None:
        mapping = validate_template_mapping(TemplateMapping.named, {'code': 'code'}, ('code', 'minutes'))
        assert mapping == {'code': 'code'}
        assert render_template_params(TemplateMapping.named, mapping, {'code': '1234', 'minutes': '5'}) == {
            'code': '1234'
        }

    def test_ordered_mapping_validates_and_renders(self) -> None:
        mapping = validate_template_mapping(TemplateMapping.ordered, ['code', 'minutes'], ('code', 'minutes'))
        assert render_template_params(TemplateMapping.ordered, mapping, {'code': '1234', 'minutes': '5'}) == [
            '1234',
            '5',
        ]

    @pytest.mark.parametrize(
        ('kind', 'mapping'),
        [
            (TemplateMapping.named, {'code': 'cdoe'}),  # 参数名拼错
            (TemplateMapping.named, []),  # 形状不对
            (TemplateMapping.named, {}),
            (TemplateMapping.ordered, {'code': 'code'}),
            (TemplateMapping.ordered, ['nope']),
            (TemplateMapping.ordered, 'code'),
        ],
    )
    def test_bad_mapping_is_rejected(self, kind: TemplateMapping, mapping: Any) -> None:
        with pytest.raises(ValueError):
            validate_template_mapping(kind, mapping, ('code', 'minutes'))
