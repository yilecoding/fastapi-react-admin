from datetime import datetime

from pydantic import ConfigDict, Field, field_validator

from backend.common.schema import ColumnLengthChecked, SchemaBase
from backend.plugin.ai.enums import ProviderType
from backend.plugin.ai.model import AiProvider


class AiProviderSchemaBase(SchemaBase):
    """AI 供应商基础模型"""

    name: str = Field(description='供应商名称')
    provider_type: ProviderType = Field(description='类型（openai/deepseek/qwen/glm/custom）')
    base_url: str = Field(description='OpenAI 兼容接口地址，必须带 /v1，如 https://api.deepseek.com/v1')
    model: str = Field(description='默认模型名')
    timeout: int = Field(120, ge=1, le=600, description='请求超时（秒）')
    verify_ssl: bool = Field(True, description='是否校验 TLS 证书（内网自签证书需要关掉）')
    max_retries: int = Field(1, ge=0, le=5, description='失败重试次数')
    use_proxy: bool = Field(False, description='是否走系统代理（内网网关按实际可达路径选，配错表现为纯超时）')
    is_default: bool = Field(False, description='是否默认供应商')
    status: int = Field(1, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, description='备注')

    @field_validator('base_url')
    @classmethod
    def check_base_url(cls, v: str) -> str:
        """只校验协议头。

        ⚠️ **刻意不强制要求带 `/v1`** —— 不是所有网关都用这个版本段，硬卡会把合法配置拒掉。
        漏写 `/v1` 的后果（404）由 `llm/client.py: _explain_http_error` 在**出错那一刻**
        解释清楚（"确认 base_url 带 /v1"），比在这里猜要准。
        """
        v = v.strip().rstrip('/')
        if not v.startswith(('http://', 'https://')):
            raise ValueError('接口地址必须以 http:// 或 https:// 开头')
        return v


class CreateAiProviderParam(ColumnLengthChecked, AiProviderSchemaBase):
    """创建 AI 供应商参数"""

    __sa_model__ = AiProvider

    api_key: str = Field(description='API Key（明文，只在这一次请求里出现，落库即加密）', min_length=1)


class UpdateAiProviderParam(ColumnLengthChecked, AiProviderSchemaBase):
    """更新 AI 供应商参数"""

    __sa_model__ = AiProvider

    # 留空 = 不改密钥。做成可选是必需的：编辑其它字段时前端拿不到原文，
    # 必填的话用户每改一次超时时间都得重新粘一次 key（然后多半会粘错）
    api_key: str | None = Field(None, description='API Key（留空表示不修改）')


class GetAiProviderDetail(AiProviderSchemaBase):
    """AI 供应商详情

    🔴 **这里没有 `api_key` 也没有 `api_key_cipher`，是刻意的。**
    密文一旦出现在任何响应里，它就和明文一样值钱了（拿到密文 + 一次代码泄露 = 明文）。
    前端要展示的只有掩码。想改密钥就重新填一次，没有"回显"这回事 —— 同密码字段。
    """

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='供应商 ID')
    api_key_mask: str = Field(description='API Key 掩码（仅展示）')
    created_time: datetime = Field(description='创建时间')


class TestAiProviderResult(SchemaBase):
    """连通性测试结果"""

    ok: bool = Field(description='是否连通')
    message: str = Field(description='结果说明')
    latency_ms: int | None = Field(None, description='往返耗时（毫秒）')
