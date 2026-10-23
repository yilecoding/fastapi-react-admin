"""AI 辅助（#111 第 1、3 条：设计器生成 · 发起时填单）共用的三件事：取客户端、调一次模型、记一行调用。

和预审（`ai_review_service`）分开：预审在 Celery 里跑、失败原因要存语言包 key 留到读的时候翻；
这两个是同步接口，失败当场翻成当前请求的语言抛给前端。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from backend.common.exception import errors
from backend.common.i18n import t
from backend.plugin.workflow.model import WfAiAssist

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


async def build_client(db: AsyncSession) -> Any:
    """取默认模型供应商的客户端。单独一个函数：测试里替换掉它，不打真模型"""
    try:
        from backend.plugin.ai.crud.crud_provider import ai_provider_dao
        from backend.plugin.ai.service.provider_service import ai_provider_service
    except ImportError as e:
        raise errors.RequestError(msg=t('error.workflow.ai_no_plugin')) from e
    provider = await ai_provider_dao.get_default(db)
    if provider is None:
        raise errors.RequestError(msg=t('error.workflow.ai_no_provider'))
    return ai_provider_service.build_client(provider)


async def complete(client: Any, messages: list[dict[str, Any]]) -> tuple[str, dict[str, int] | None]:
    """流式接口拼成整段（AI 插件的客户端只有流式这一种）。

    🔴 开 JSON 模式（服务端约束解码）：不开的话 Qwen3-VL 在采购那个例子上连着两次少一个 `}`，
    把解析器的原话回给它修也没修好；开了之后两个模型都是合法 JSON
    """
    parts: list[str] = []
    usage = None
    async for delta in client.stream_chat(messages, temperature=0, response_format={'type': 'json_object'}):
        parts.append(delta.text)
        usage = delta.usage or usage
    return ''.join(parts), usage


async def record(db: AsyncSession, **values: Any) -> None:
    """调用记录单独一个事务：生成失败也要留下这一行"""
    if db.in_transaction():
        await db.rollback()
    async with db.begin():
        db.add(WfAiAssist(**values))
