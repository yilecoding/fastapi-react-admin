import time

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.plugin.ai.crud.crud_provider import ai_provider_dao
from backend.plugin.ai.llm.client import OpenAICompatClient
from backend.plugin.ai.model import AiProvider
from backend.plugin.ai.schema.provider import CreateAiProviderParam, TestAiProviderResult, UpdateAiProviderParam
from backend.utils.encrypt import AESCipher


def _cipher() -> AESCipher:
    """取加密器。

    🔴 **没配密钥就拒绝保存，不静默存明文。** 这是 fail-closed 的典型场景：
    "存了但没加密"在界面上和"存了且加密了"完全一样，等发现时密钥已经在库里躺了很久。
    """
    key = settings.AI_ENCRYPT_SECRET_KEY
    if not key:
        raise errors.ServerError(
            msg='未配置 AI_ENCRYPT_SECRET_KEY，无法安全保存模型密钥。'
            '生成方式：python -c "import os;print(os.urandom(32).hex())"，'
            '写入 plugin.toml 的 [settings] 或 .env 后重启服务'
        )
    try:
        return AESCipher(key)
    except ValueError as e:
        raise errors.ServerError(
            msg=f'AI_ENCRYPT_SECRET_KEY 不是合法的十六进制密钥（需 32 字节 / 64 位十六进制）：{e}'
        ) from e


def mask_key(api_key: str) -> str:
    """生成展示用掩码。

    短 key 一律全掩 —— 对 8 位以内的 key 露出首尾等于露出大半个密钥。
    """
    if len(api_key) <= 8:
        return '*' * len(api_key)
    return f'{api_key[:6]}{"*" * 6}{api_key[-4:]}'


class AiProviderService:
    """AI 供应商管理"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> AiProvider:
        provider = await ai_provider_dao.get(db, pk)
        if not provider:
            raise errors.NotFoundError(msg='模型供应商不存在')
        return provider

    @staticmethod
    async def get_list(*, db: AsyncSession, name: str | None, status: int | None) -> dict[str, Any]:
        select = await ai_provider_dao.get_select(name=name, status=status)
        return await paging_data(db, select)

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateAiProviderParam, user_id: int) -> None:
        if await ai_provider_dao.get_by_name(db, obj.name):
            raise errors.ConflictError(msg='同名的模型供应商已存在')

        cipher = _cipher()
        data = obj.model_dump(exclude={'api_key'})
        provider = AiProvider(
            **data,
            api_key_cipher=cipher.encrypt(obj.api_key).hex(),
            api_key_mask=mask_key(obj.api_key),
            created_by=user_id,
        )
        db.add(provider)
        await db.flush()

        if obj.is_default:
            await ai_provider_dao.clear_default(db, exclude_pk=provider.id)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateAiProviderParam) -> int:
        provider = await ai_provider_dao.get(db, pk)
        if not provider:
            raise errors.NotFoundError(msg='模型供应商不存在')

        existing = await ai_provider_dao.get_by_name(db, obj.name)
        if existing and existing.id != pk:
            raise errors.ConflictError(msg='同名的模型供应商已存在')

        data = obj.model_dump(exclude={'api_key'})
        # 留空 = 不动密钥。注意是 `if obj.api_key` 不是 `if obj.api_key is not None` ——
        # 前端把输入框清空后传的是空串，那同样是"不改"而不是"把密钥改成空"
        if obj.api_key:
            cipher = _cipher()
            data['api_key_cipher'] = cipher.encrypt(obj.api_key).hex()
            data['api_key_mask'] = mask_key(obj.api_key)

        for field, value in data.items():
            setattr(provider, field, value)
        await db.flush()

        if obj.is_default:
            await ai_provider_dao.clear_default(db, exclude_pk=pk)
        return 1

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        return await ai_provider_dao.delete(db, pk)

    @staticmethod
    def build_client(provider: AiProvider) -> OpenAICompatClient:
        """把一行供应商配置变成一个可用的客户端（解密发生在这一刻，不落地）"""
        return OpenAICompatClient(
            base_url=provider.base_url,
            api_key=_cipher().decrypt(provider.api_key_cipher),
            model=provider.model,
            timeout=provider.timeout,
            verify_ssl=provider.verify_ssl,
            use_proxy=provider.use_proxy,
        )

    @classmethod
    async def test(cls, *, db: AsyncSession, pk: int) -> TestAiProviderResult:
        """连通性测试：发一句最短的对话，看能不能出字。

        比"请求一下 /models 接口"更可靠 —— 有的网关 `/models` 通、`/chat/completions`
        却因为模型名不对而失败，而后者才是真正要用的那条路。
        """
        provider = await cls.get(db=db, pk=pk)
        client = cls.build_client(provider)
        started = time.perf_counter()
        try:
            async for _ in client.stream_chat([{'role': 'user', 'content': '你好'}]):
                # 拿到第一帧就够了：证明鉴权、地址、模型名三样都是对的
                break
        except Exception as e:
            return TestAiProviderResult(ok=False, message=str(e), latency_ms=None)
        return TestAiProviderResult(ok=True, message='连接正常', latency_ms=int((time.perf_counter() - started) * 1000))


ai_provider_service: AiProviderService = AiProviderService()
