"""数据变更审计（#260）：参数配置。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 `value` **按行**判断敏感：`EMAIL_PASSWORD`（SMTP 密码 / 授权码）就存在这张表里。第一版把 `value` 一律当普通列记，
评审指出之后改成：键名像密钥的行只记「改过」。规则在 `common/secret_keys.py`，和前端参数配置页打码、操作日志打码
共用一条（后缀匹配、不分大小写，`USER_PASSWORD_MIN_LENGTH` 这种策略类的键不受影响）。
原来这里自己抄了一份，区分大小写、没有 CREDENTIALS，和前端对不上。
"""

from collections.abc import Mapping
from typing import Any

from backend.common.data_change import register_audited
from backend.common.secret_keys import is_secret_key_name
from backend.plugin.config.model import Config


def is_secret_row(row: Mapping[str, Any]) -> bool:
    return is_secret_key_name(row.get('key'))


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
    secret_when={'value': is_secret_row},
    ignore={'created_time', 'updated_time', 'deleted_time'},
    soft_delete='deleted',
)
