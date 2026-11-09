"""数据变更审计（#260）：谁、什么时候、从哪来，把哪个对象的哪个字段从什么改成了什么。

- 登记：`registry.register_audited`（对象）/ `register_audited_set`（关联表 → 父对象的集合字段）/
  `register_audited_child`（一对一子表 → 父对象的开关字段，用户的二次验证）
  （内置在 `app/admin/data_change.py`，插件放自己的 `data_change.py`）
- 拦截：`capture.install_data_change_capture()`，`database/db.py` 导入时装上
- 来源：`with data_change_source('ai', ref=…):` 包住的修改记成别的来源

坑和实测见同目录 `AGENTS.md`。
"""

from backend.common.data_change.capture import data_change_source as data_change_source
from backend.common.data_change.capture import install_data_change_capture as install_data_change_capture
from backend.common.data_change.registry import ChildValue as ChildValue
from backend.common.data_change.registry import Ref as Ref
from backend.common.data_change.registry import register_audited as register_audited
from backend.common.data_change.registry import register_audited_child as register_audited_child
from backend.common.data_change.registry import register_audited_set as register_audited_set
