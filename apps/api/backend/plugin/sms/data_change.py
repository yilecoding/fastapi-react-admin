"""数据变更审计（#281）：短信配置。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 凭据 secret 只记「改过」；`secret_mask` 跟着变，不记。
`options` 按普通值记 —— 能这么记的前提是凭据进不了 `options`
（保存时 `config_service._validate` 拒收，`test_sms_config_api.py` 守着）。
`options` / `templates` 是 JSON 文本，整段记。
"""

from backend.common.data_change import register_audited
from backend.plugin.sms.model import SmsConfig

register_audited(
    SmsConfig,
    entity='sms_config',
    title='短信配置',
    label='name',
    fields={
        'name': '名称',
        'provider': '厂商',
        'sign_name': '短信签名',
        'options': '厂商配置',
        'templates': '模板',
        'access_key_id': '凭据 Key',
        'weight': '权重',
        'daily_max': '日上限',
        'timeout': '超时（秒）',
        'is_default': '默认配置',
        'status': '状态',
        'remark': '备注',
    },
    enums={'is_default': {0: '否', 1: '是'}, 'status': {0: '停用', 1: '正常'}},
    secret={'secret_cipher': '凭据 Secret'},
    ignore={'secret_mask', 'created_by', 'created_time', 'updated_time', 'deleted_time'},
    soft_delete='deleted',
)
