"""数据变更审计（#260）：参数配置。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

`value` 按普通列记旧值 → 新值：这张表的值本来就原样显示在参数配置页上、`PUT /sys/configs` 的请求体也进操作日志，
密钥类的东西本来就不放这里（`core/conf.py` 里用户导入默认密码那条注释）。
"""

from backend.common.data_change import register_audited
from backend.plugin.config.model import Config

register_audited(
    Config,
    entity='config',
    title='参数配置',
    label='key',
    fields={
        'name': '名称',
        'type': '分组',
        'key': '键名',
        'value': '键值',
        'is_frontend': '前端可读',
        'remark': '备注',
    },
    ignore={'created_time', 'updated_time', 'deleted_time'},
    soft_delete='deleted',
)
