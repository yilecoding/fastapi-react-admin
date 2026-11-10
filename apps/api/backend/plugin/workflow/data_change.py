"""数据变更审计（#281）：流程定义。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 草稿（`draft_form_json` / `draft_model_json`）不记：设计器里点一次保存就是一整段 JSON，记了就是刷屏，而且草稿不生效。
生效的是**发布**：发布出一个只读版本（`wf_definition_version`，本身就是历史），这里记「已发布版本：1 → 2」。
实例 / 待办 / 审批记录是业务流转，有自己的记录，不进数据变更审计（#260「不做」）。
"""

from backend.common.data_change import Ref, register_audited
from backend.plugin.workflow.model import WfDefinition

register_audited(
    WfDefinition,
    entity='wf_definition',
    title='流程定义',
    label='name',
    fields={
        'code': '编码',
        'name': '名称',
        'biz_type': '业务类型',
        'category': '分组',
        'icon': '图标',
        'description': '说明',
        'status': '状态',
        'sort': '排序',
    },
    refs={'current_version_id': ('已发布版本', Ref('wf_definition_version', 'version_no'))},
    enums={'status': {'draft': '草稿', 'published': '已发布', 'disabled': '已停用'}},
    ignore={'draft_form_json', 'draft_model_json', 'created_time', 'updated_time', 'deleted_time'},
    soft_delete='deleted',
)
