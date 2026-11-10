"""数据变更审计（#281）：字典类型 · 字典项。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

字典项单独算一类对象（不折叠进类型）：一个类型下几十项，折叠的话改一项就是类型上一条「字典项：…」，看不出改的是哪一项的什么。
所属类型按引用记（存当时的类型名）；`type_code` 是类型编码的冗余副本，不另记。
"""

from backend.common.data_change import Ref, register_audited
from backend.plugin.dict.model import DictData, DictType

_TIMESTAMPS = {'created_time', 'updated_time', 'deleted_time'}

register_audited(
    DictType,
    entity='dict_type',
    title='字典类型',
    label='name',
    fields={'name': '名称', 'code': '编码', 'remark': '备注'},
    ignore=_TIMESTAMPS,
    soft_delete='deleted',
)

register_audited(
    DictData,
    entity='dict_data',
    title='字典项',
    label='label',
    fields={'label': '标签', 'value': '值', 'color': '颜色', 'sort': '排序', 'status': '状态', 'remark': '备注'},
    refs={'type_id': ('字典类型', Ref('sys_dict_type', 'name'))},
    enums={'status': {0: '停用', 1: '正常'}},
    ignore={'type_code', *_TIMESTAMPS},
    soft_delete='deleted',
)
