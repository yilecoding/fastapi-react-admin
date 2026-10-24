"""本地假厂商服务器：给 SDK 契约测试用，**用真 SDK 打它**（不 mock SDK）。

`mode` 决定下一次请求怎么答。两家的响应形状各自照文档 / 实测的样子拼。
"""

from __future__ import annotations

import asyncio
import json

from dataclasses import dataclass, field
from typing import Any

from aiohttp import web


@dataclass
class FakeProvider:
    """起在 127.0.0.1 随机端口上的 HTTP 服务器"""

    vendor: str  # 'aliyun' | 'tencent'
    mode: str = 'ok'
    #: 业务失败 / 接口级错误时返回的错误码
    code: str = ''
    #: 收到的请求（方法、路径、头、表单 / JSON 体）
    requests: list[dict[str, Any]] = field(default_factory=list)
    port: int = 0
    _runner: web.AppRunner | None = None

    @property
    def endpoint(self) -> str:
        return f'127.0.0.1:{self.port}'

    async def start(self) -> FakeProvider:
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', self._handle)
        # 收尾不等挂着的 hang 处理器（它在故意不答）：等它等于把读超时的测试拖成服务器的 sleep 时长
        self._runner = web.AppRunner(app, shutdown_timeout=0.2)
        await self._runner.setup()
        site = web.TCPSite(self._runner, '127.0.0.1', 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return self

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        body = await request.text()
        self.requests.append({
            'method': request.method,
            'path': request.path,
            'query': dict(request.query),
            'headers': dict(request.headers),
            'body': body,
        })
        if self.mode == 'hang':
            # 连上了、也收到请求了，就是不答 —— 客户端会读超时（结果未知）
            await asyncio.sleep(8)
            return web.Response(text='too late')
        if self.mode == 'server_5xx_html':
            return web.Response(status=502, text='<html>Bad Gateway</html>', content_type='text/html')
        return self._aliyun(body) if self.vendor == 'aliyun' else self._tencent()

    # ── 阿里云：RPC 风格，表单体，HTTP 200 + body.Code ──────────────────────
    def _aliyun(self, body: str) -> web.Response:
        rid = 'ALI-REQ-0001'
        if self.mode == 'ok':
            return web.json_response({'Code': 'OK', 'Message': 'OK', 'BizId': 'BIZ-0001', 'RequestId': rid})
        if self.mode == 'biz_fail':
            return web.json_response({'Code': self.code, 'Message': f'mock {self.code}', 'RequestId': rid})
        if self.mode == 'api_error':
            # 4xx 带 JSON：SDK 抛 ClientException(.code)
            return web.json_response(
                {
                    'Code': self.code,
                    'Message': f'mock {self.code}',
                    'RequestId': rid,
                    'HostId': 'dysmsapi.aliyuncs.com',
                },
                status=404 if self.code == 'InvalidAccessKeyId.NotFound' else 400,
            )
        raise AssertionError(f'未知 mode {self.mode}')

    # ── 腾讯云：JSON 体，{"Response": {...}} ──────────────────────────────────
    def _tencent(self) -> web.Response:
        rid = 'TC-REQ-0001'
        if self.mode == 'ok':
            payload = {
                'Response': {
                    'SendStatusSet': [
                        {
                            'SerialNo': 'SERIAL-0001',
                            'PhoneNumber': '+8613800000000',
                            'Fee': 1,
                            'SessionContext': 'ctx',
                            'Code': 'Ok',
                            'Message': 'send success',
                            'IsoCode': 'CN',
                        }
                    ],
                    'RequestId': rid,
                }
            }
            return web.Response(text=json.dumps(payload), content_type='application/json')
        if self.mode == 'biz_fail':
            payload = {
                'Response': {
                    'SendStatusSet': [
                        {
                            'SerialNo': '',
                            'PhoneNumber': '+8613800000000',
                            'Fee': 0,
                            'SessionContext': 'ctx',
                            'Code': self.code,
                            'Message': f'mock {self.code}',
                            'IsoCode': 'CN',
                        }
                    ],
                    'RequestId': rid,
                }
            }
            return web.Response(text=json.dumps(payload), content_type='application/json')
        if self.mode in ('api_error', 'api_error_charset'):
            payload = {'Response': {'Error': {'Code': self.code, 'Message': f'mock {self.code}'}, 'RequestId': rid}}
            # 🔴 实测：响应头带 charset 时 SDK 的 check_err 认不出 Content-Type，错误被吞成空响应
            headers = (
                {'Content-Type': 'application/json; charset=utf-8'}
                if self.mode == 'api_error_charset'
                else {'Content-Type': 'application/json'}
            )
            return web.Response(body=json.dumps(payload).encode(), headers=headers)
        raise AssertionError(f'未知 mode {self.mode}')
