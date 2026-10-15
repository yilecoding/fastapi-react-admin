"""OpenAI 兼容的流式 chat 客户端。

**刻意不引入任何 LLM SDK**：`openai` / `langchain-openai` 带来的东西我们几乎都不用
（它们的会话管理、重试、provider 抽象都要被我们自己那套替换掉），而多一个依赖就是
多一条要跟着升级的链。协议本身只是一个 POST + SSE 解析。

两条约束来自真实的内网网关（参考 `sop2ppt` 的 `app/llm/client.py`），
不实现的话失败方式都极具误导性：

- `verify=False`：内网自签 / 内网 CA 证书，Python 的 certifi 验不过。
  报错是 `SSLCertVerificationError`，看起来像"网关挂了"
- 代理走不走由 `use_proxy` 决定（`trust_env`），**不能写死**：同一个内网网关
  在不同位置的可达路径可能是相反的。实测：本机 WSL 里直连 TCP 全被挡、必须经
  企业代理才通；而 sop2ppt 那台机器上是代理到不了、必须直连。
  配错的表现都是纯超时，看起来像"网关挂了"。默认 `False`（直连）
"""

import json

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from backend.common.exception import errors
from backend.common.log import log


@dataclass(slots=True)
class StreamDelta:
    """一次流式增量：要么是正文片段，要么是工具调用的片段，也可能都有"""

    text: str = ''
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, int] | None = None


class OpenAICompatClient:
    """一个供应商配置对应一个客户端实例"""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout: int = 120,
        verify_ssl: bool = True,
        use_proxy: bool = False,
    ) -> None:
        # base_url 必须带 /v1（供应商配置那一层已经校验过），这里只做尾斜杠归一
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.verify_ssl = verify_ssl
        self.use_proxy = use_proxy

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            verify=self.verify_ssl,
            trust_env=self.use_proxy,
            timeout=httpx.Timeout(self.timeout, connect=min(30, self.timeout)),
            headers={
                'Authorization': f'Bearer {self.api_key}',
                'Content-Type': 'application/json',
            },
        )

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        *,
        temperature: float = 0.3,
    ) -> AsyncIterator[StreamDelta]:
        """流式调用 `/chat/completions`。

        :param messages: OpenAI 形状的消息列表
        :param tools: OpenAI function-calling 形状的工具定义；为空则不带这个字段
        """
        payload: dict[str, Any] = {
            'model': self.model,
            'messages': messages,
            'stream': True,
            'temperature': temperature,
            # 要用量就得显式开，否则最后一帧没有 usage。不是所有网关都支持，
            # 不支持的会忽略这个字段（而不是报错），所以带上是安全的
            'stream_options': {'include_usage': True},
        }
        if tools:
            payload['tools'] = tools
            payload['tool_choice'] = 'auto'

        async with self._client() as client:
            try:
                async with client.stream('POST', f'{self.base_url}/chat/completions', json=payload) as response:
                    if response.status_code != 200:
                        body = (await response.aread()).decode('utf-8', errors='replace')
                        log.error(f'LLM 网关返回 {response.status_code}: {body[:500]}')
                        # 把网关的状态码翻译成一句人能懂的话。直接把上游 JSON 糊给用户
                        # 是最没用的做法 —— 它通常是一段英文的 provider 内部错误
                        raise errors.ServerError(msg=_explain_http_error(response.status_code, body))

                    async for line in response.aiter_lines():
                        delta = _parse_sse_line(line)
                        if delta is not None:
                            yield delta
            except httpx.ConnectError as e:
                raise errors.ServerError(msg=f'连不上模型网关（{self.base_url}）：{e}') from e
            except httpx.ReadTimeout as e:
                raise errors.ServerError(msg=f'模型响应超时（{self.timeout} 秒）') from e


def _explain_http_error(status: int, body: str) -> str:
    """把网关 HTTP 状态翻译成面向用户的话"""
    if status == 401:
        return 'API Key 无效或已过期，请在「模型密钥管理」里更新'
    if status == 404:
        return '接口地址不对：请确认 base_url 带 /v1（例如 https://host/v1）'
    if status == 429:
        return '模型网关限流，请稍后再试'
    snippet = body.strip()[:200]
    return f'模型网关返回 {status}：{snippet}'


def _parse_sse_line(line: str) -> StreamDelta | None:
    """解析一行 SSE。

    ⚠️ 空行、注释行（`:` 开头的心跳）、`[DONE]` 都要安静跳过 ——
    把它们当成 JSON 解析会在对话中途抛异常，而上一秒还在正常出字。
    """
    if not line or not line.startswith('data:'):
        return None
    data = line[5:].strip()
    if not data or data == '[DONE]':
        return None

    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        log.warning(f'LLM 流式响应里有一行解析不了，已跳过：{data[:200]}')
        return None

    result = StreamDelta()
    if usage := chunk.get('usage'):
        result.usage = {
            'prompt_tokens': usage.get('prompt_tokens', 0),
            'completion_tokens': usage.get('completion_tokens', 0),
        }

    choices = chunk.get('choices') or []
    if not choices:
        # 只带 usage 的收尾帧没有 choices，这是正常的
        return result if result.usage else None

    choice = choices[0]
    delta = choice.get('delta') or {}
    result.text = delta.get('content') or ''
    result.tool_calls = delta.get('tool_calls') or []
    result.finish_reason = choice.get('finish_reason')
    return result


def accumulate_tool_calls(buffer: dict[int, dict[str, Any]], deltas: list[dict[str, Any]]) -> None:
    """把流式的工具调用增量按 `index` 累积进 buffer。

    🔴 **这是整条流式链路里最容易写错的一处。** OpenAI 把一次工具调用拆成多个
    delta 发：`id` 只在第一个片段里出现，`function.arguments` 是**一个字符串被切碎**，
    要按 index 拼回去。常见的错法是每个 delta 当成一次独立调用 ——
    表现是模型"调用了 20 次工具"，每次参数都是残缺的 JSON 片段，
    而解析失败被当成"模型参数填错了"，永远查不到流式解析这一层。
    """
    for item in deltas:
        index = item.get('index', 0)
        slot = buffer.setdefault(index, {'id': '', 'name': '', 'arguments': ''})
        if item_id := item.get('id'):
            slot['id'] = item_id
        function = item.get('function') or {}
        if name := function.get('name'):
            slot['name'] = name
        if (arguments := function.get('arguments')) is not None:
            # 用 += 不是 =：这里收到的是被切碎的片段
            slot['arguments'] += arguments
