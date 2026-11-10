"""数据变更审计（#281）：模型密钥（AI 服务商）· MCP 凭据。

由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 API Key 密文、MCP 令牌的 sha256 只记「改过」；掩码 / 前几位跟着变，不记。`last_used_time` 每次鉴权都写，不记。
"""

from backend.common.data_change import register_audited
from backend.plugin.ai.model import AiMcpClient, AiProvider

_STATUS = {0: '停用', 1: '正常'}
_YES_NO = {0: '否', 1: '是'}
_TIMESTAMPS = {'created_time', 'updated_time', 'deleted_time'}

register_audited(
    AiProvider,
    entity='ai_provider',
    title='模型密钥',
    label='name',
    fields={
        'name': '名称',
        'provider_type': '类型',
        'base_url': '接口地址',
        'model': '模型',
        'timeout': '超时（秒）',
        'verify_ssl': '校验 TLS 证书',
        'max_retries': '重试次数',
        'use_proxy': '走系统代理',
        'is_default': '默认',
        'status': '状态',
        'remark': '备注',
    },
    enums={'verify_ssl': _YES_NO, 'use_proxy': _YES_NO, 'is_default': _YES_NO, 'status': _STATUS},
    secret={'api_key_cipher': 'API Key'},
    ignore={'api_key_mask', 'created_by', *_TIMESTAMPS},
    soft_delete='deleted',
)

register_audited(
    AiMcpClient,
    entity='ai_mcp_client',
    title='MCP 凭据',
    label='name',
    fields={
        'client_id': '凭据标识',
        'name': '名称',
        'act_as': '可代表的用户',
        'allow_superuser': '允许代表超级管理员',
        'allow_write': '允许写操作',
        'tools': '工具白名单',
        'rate_per_minute': '每分钟请求上限',
        'status': '状态',
        'remark': '备注',
    },
    enums={'allow_superuser': _YES_NO, 'allow_write': _YES_NO, 'status': _STATUS},
    secret={'token_sha256': '令牌'},
    ignore={'token_hint', 'last_used_time', 'created_by', *_TIMESTAMPS},
    soft_delete='deleted',
)
