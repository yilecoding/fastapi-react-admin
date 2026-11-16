"""模型调用失败时给人看的话，不带上游响应体和地址（#317）。

`base_url` 只校验协议头，可以指向任意内网地址：「测试连接」把上游响应体回给调用者 = 能读内网服务报错内容的半盲 SSRF；
对话的错误帧把网关地址发给每一个能聊天的普通用户。要守的都是「界面上照常显示一句报错」的那一类，所以断言的是报错里**没有**什么。
"""

import os
import socket
import threading
import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from pydantic_ai.exceptions import ModelHTTPError
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.plugin.ai.llm.client import CONNECT_FAILED, user_facing_error
from backend.plugin.ai.model import AiProvider
from backend.tests.utils.data_change import engine

PROVIDERS = '/ai/providers'
SECRET = 'INTERNAL-ONLY-7f3a'
_RUN = uuid.uuid4().hex[:8]


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    yield
    with engine().begin() as conn:
        conn.execute(sa.delete(AiProvider.__table__).where(AiProvider.__table__.c.name.like(f'pytest-err-{_RUN}%')))


@pytest.fixture
def upstream() -> Iterator[tuple[str, list[int]]]:
    """真 socket 的「内网服务」：按 `status[0]` 回状态码，响应体里带一段不该外泄的内容"""
    status = [500]
    srv = socket.create_server(('127.0.0.1', 0))
    srv.settimeout(0.2)
    stop = threading.Event()

    def _serve() -> None:
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
            except TimeoutError:
                continue
            with conn:
                conn.recv(65536)
                body = f'{{"error": "db password is {SECRET}"}}'.encode()
                head = (
                    f'HTTP/1.1 {status[0]} X\r\ncontent-type: application/json\r\ncontent-length: {len(body)}\r\n\r\n'
                )
                conn.sendall(head.encode() + body)

    thread = threading.Thread(target=_serve, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{srv.getsockname()[1]}/v1', status
    stop.set()
    thread.join(5)
    srv.close()


def _create(client: TestClient, headers: dict[str, str], base_url: str, suffix: str) -> int:
    name = f'pytest-err-{_RUN}-{suffix}'
    body = {'name': name, 'provider_type': 'custom', 'base_url': base_url, 'model': 'm', 'api_key': 'sk-x'}
    assert client.post(PROVIDERS, headers=headers, json=body).json()['code'] == 200
    with engine().connect() as conn:
        table = AiProvider.__table__
        return conn.execute(sa.select(table.c.id).where(table.c.name == name)).scalar_one()


@pytest.mark.parametrize('code', [400, 500, 502])
def test_test_endpoint_does_not_echo_the_upstream_body(
    client: TestClient, token_headers: dict[str, str], upstream: tuple[str, list[int]], code: int
) -> None:
    base_url, status = upstream
    status[0] = code
    pk = _create(client, token_headers, base_url, str(code))
    result = client.post(f'{PROVIDERS}/{pk}/test', headers=token_headers).json()['data']
    assert result['ok'] is False
    assert str(code) in result['message'], '状态码要留着：管理员排查靠它'
    assert SECRET not in result['message']
    assert '127.0.0.1' not in result['message']


def test_unreachable_gateway_does_not_reveal_its_address(client: TestClient, token_headers: dict[str, str]) -> None:
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()  # 端口空着：连接被拒
    pk = _create(client, token_headers, f'http://127.0.0.1:{port}/v1', 'down')
    result = client.post(f'{PROVIDERS}/{pk}/test', headers=token_headers).json()['data']
    assert result == {'ok': False, 'message': CONNECT_FAILED, 'latency_ms': None}


class TestUserFacingError:
    """两个引擎、填单 / 设计器的兜底都走它：pydantic-ai 的异常里带着上游响应体"""

    def test_model_http_error_keeps_the_status_drops_the_body(self) -> None:
        e = ModelHTTPError(status_code=500, model_name='m', body={'error': SECRET})
        assert SECRET in str(e), '前置：str(e) 本来就带着响应体'
        message = user_facing_error(e)
        assert '500' in message
        assert SECRET not in message

    def test_pydantic_ai_connection_failures_read_the_same_as_native(self) -> None:
        """pydantic-ai 把 openai 的连接 / 超时错误包成 `ModelAPIError`（`raise … from e`）：只看最外层的话，
        同一次断网 pydantic_ai 引擎说「ModelAPIError」、native 引擎说「连不上」"""
        import httpx
        import openai

        from pydantic_ai.exceptions import ModelAPIError

        request = httpx.Request('POST', 'http://10.0.0.5/v1/chat/completions')
        for inner, expected in [
            (openai.APIConnectionError(request=request), CONNECT_FAILED),
            (openai.APITimeoutError(request=request), '模型响应超时，请稍后再试'),
        ]:
            try:
                try:
                    raise inner
                except openai.APIConnectionError as cause:
                    raise ModelAPIError(model_name='m', message=str(cause)) from cause
            except ModelAPIError as wrapped:
                assert user_facing_error(wrapped) == expected

    def test_unknown_exception_text_is_not_shown(self) -> None:
        message = user_facing_error(RuntimeError(f'connect to http://10.0.0.5:9200/{SECRET} failed'))
        assert SECRET not in message
        assert '10.0.0.5' not in message
        assert 'RuntimeError' in message
