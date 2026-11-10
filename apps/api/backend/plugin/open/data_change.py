"""数据变更审计（#281）：开放应用 · Webhook 端点。

由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 密钥列（`*_cipher`）只记「改过」：密文 + 加密密钥 = 明文。
`*_hint` 跟着密文变，不记（换一次密钥多一条重复的「前几位」变化）。

- Webhook 的接收地址也只记「改过」：对接方常把令牌放在查询串里，而有 `log:change:list` 的人不一定能看 Webhook 页
- `secret_prev_*` 是轮换时自动挪过去的旧密钥，「签名密钥：已修改」已经说明了，不另记
- 投递那几列（连续失败次数、最近投递 / 成功时间）每投一次都写，记了就是刷屏；
  自动停用表现为「状态：正常 → 停用」、来源是定时任务 / 系统，
  停用原因 / 时间不另记
"""

from backend.common.data_change import Ref, register_audited
from backend.plugin.open.model import OpenApp, OpenWebhook

_STATUS = {0: '停用', 1: '正常'}

register_audited(
    OpenApp,
    entity='open_app',
    title='开放应用',
    label='name',
    fields={
        'name': '应用名称',
        'code': '应用编码',
        'access_key': 'Access Key',
        'scopes': '授权接口',
        'ip_whitelist': 'IP 白名单',
        'rate_per_minute': '每分钟请求上限',
        'expire_time': '失效时间',
        'status': '状态',
        'remark': '备注',
    },
    enums={'status': _STATUS},
    secret={'secret_cipher': 'Secret Key'},
    # last_used_time 每次调用开放接口都写
    ignore={'secret_hint', 'last_used_time', 'created_by', 'created_time', 'updated_time', 'deleted_time'},
    soft_delete='deleted',
)

register_audited(
    OpenWebhook,
    entity='open_webhook',
    title='Webhook 端点',
    label='name',
    fields={'name': '端点名称', 'events': '订阅的事件', 'status': '状态', 'remark': '备注'},
    refs={'app_id': ('所属应用', Ref('open_app', 'name'))},
    enums={'status': _STATUS},
    secret={'url': '接收地址', 'secret_cipher': '签名密钥'},
    ignore={
        'secret_hint',
        'secret_prev_cipher',
        'secret_prev_expire_time',
        'disabled_reason',
        'disabled_time',
        'consecutive_failures',
        'first_failure_time',
        'last_delivery_time',
        'last_success_time',
        'created_by',
        'created_time',
        'updated_time',
    },
)
