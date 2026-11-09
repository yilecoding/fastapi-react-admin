"""数据变更审计（#260）：参数配置。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 `value` **按行**判断敏感：`EMAIL_PASSWORD`（SMTP 密码 / 授权码）就存在这张表里。第一版把 `value` 一律当普通列记，
评审指出之后改成：键名以 PASSWORD / SECRET / TOKEN / API_KEY 结尾的行只记「改过」—— 和前端参数配置页打码的规则
（`pages/config` 分册「打码判断要用后缀匹配」）是同一条，`USER_PASSWORD_MIN_LENGTH` 这种策略类的键不受影响。
"""

import re

from collections.abc import Mapping
from typing import Any

from backend.common.data_change import register_audited
from backend.plugin.config.model import Config

#: 和前端 `pages/config` 打码的判断同一条规则：后缀匹配，不是 includes
SECRET_KEY = re.compile(r'(PASSWORD|SECRET|TOKEN|API_?KEY)$')


def is_secret_row(row: Mapping[str, Any]) -> bool:
    return bool(SECRET_KEY.search(str(row.get('key') or '')))


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
