"""邮件发送失败必须可见（issue #64，硬纪律 9）。

`send_email()` 原来吞掉了所有 SMTP 异常（凭据错误/中转不可达/超时），只记
日志然后正常返回。调用方（`send_email_captcha`）没有任何办法知道发信失败，
无条件 `response_base.success()`——客户端收到 200，却等一封永远不会到达
的邮件，验证码 3 分钟后过期，报的还是一句和真实原因毫不相关的"验证码已过期"。
"""

import asyncio

from unittest.mock import AsyncMock, patch

import pytest

from starlette.testclient import TestClient

from backend.common.exception import errors


def test_send_email_captcha_returns_error_status_when_smtp_fails(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """端到端回归：SMTP 失败时 /emails/captcha 不能返回 200

    直接 monkeypatch 路由模块里绑的 `send_email` 引用，不用真的连 SMTP——
    这条测试要钉住的是"调用方看到失败"这件事本身，不是发信本身。
    """
    import backend.plugin.email.api.v1.email as email_api

    async def _boom(*args, **kwargs):
        await asyncio.sleep(0)
        raise errors.GatewayError(msg='邮件发送失败，请稍后重试或联系管理员')

    monkeypatch.setattr(email_api, 'send_email', _boom)

    resp = client.post('/emails/captcha', json={'recipients': 'a@example.com'}, headers=token_headers)
    assert resp.status_code == 502, resp.text
    assert resp.json()['code'] != 200


def test_send_email_raises_gateway_error_on_smtp_failure() -> None:
    """SMTP 登录/发信失败必须往上抛，不能吞掉后正常返回

    ⚠️ `load_email_config()` 也一并 mock 掉，不起真实数据库引擎——这条只关心
    `send_email()` 自己那段 `try/except` 的行为，不需要真的连库，顺便避开了
    "同一进程里 TestClient 用过一次事件循环之后，另起 asyncio.run() 会把
    后台任务绑到错误的循环上"这类已经在别处（`test_scheduler.py`/
    `test_data_permission.py`）反复踩过的坑——干脆不需要引擎就不会撞上。
    """
    from backend.plugin.email.utils.send import send_email

    async def go() -> None:
        with (
            patch('backend.plugin.email.utils.send.load_email_config', AsyncMock()),
            patch('backend.plugin.email.utils.send.SMTP') as mock_smtp_cls,
        ):
            mock_client = mock_smtp_cls.return_value
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.login = AsyncMock(side_effect=ConnectionError('boom'))
            mock_client.sendmail = AsyncMock()

            with pytest.raises(errors.GatewayError):
                await send_email(None, 'a@example.com', '主题', '正文')

    asyncio.run(go())
