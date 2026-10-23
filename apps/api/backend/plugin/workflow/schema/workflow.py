from typing import Any, Literal

from pydantic import Field

from backend.common.schema import ColumnLengthChecked, SchemaBase, SnowflakeIdIn
from backend.plugin.workflow.enums import FORM_BIZ_TYPE, Action
from backend.plugin.workflow.model import WfDefinition

#: 幂等键：前端每次提交生成一个 UUID。⚠️ 用 http 访问内网时没有 `crypto.randomUUID`
#: （avc-bp `d694615c`），前端要带 fallback —— 后端只要求长度
IdempotencyKey = Field(min_length=8, max_length=64, description='幂等键（每次提交一个新的 UUID）')


class CreateDefinitionParam(ColumnLengthChecked, SchemaBase):
    """新建流程定义"""

    __sa_model__ = WfDefinition

    code: str = Field(pattern=r'^[A-Za-z][A-Za-z0-9_]{1,63}$', description='编码（创建后不可改）')
    name: str = Field(min_length=1, description='名称')
    biz_type: str = Field(FORM_BIZ_TYPE, description='业务类型，表单审批为 form')
    category: str | None = Field(None, description='分组')
    icon: str | None = Field(None, description='图标')
    description: str | None = Field(None, description='说明')
    sort: int = Field(0, ge=0, description='排序')
    form: dict[str, Any] | None = Field(None, description='表单草稿')
    model: dict[str, Any] | None = Field(None, description='流程草稿')


class UpdateDefinitionParam(ColumnLengthChecked, SchemaBase):
    """更新流程定义（草稿）。刻意不含 `code` 和 `biz_type`：前者是稳定引用键，后者换了在途实例的回调就错了"""

    __sa_model__ = WfDefinition

    name: str | None = Field(None, min_length=1, description='名称')
    category: str | None = Field(None, description='分组')
    icon: str | None = Field(None, description='图标')
    description: str | None = Field(None, description='说明')
    sort: int | None = Field(None, ge=0, description='排序')
    form: dict[str, Any] | None = Field(None, description='表单草稿')
    model: dict[str, Any] | None = Field(None, description='流程草稿')


class SetDefinitionStatusParam(SchemaBase):
    enabled: bool = Field(description='启用 / 停用')


class AiDesignParam(SchemaBase):
    prompt: str = Field(min_length=2, max_length=2000, description='一句话描述要什么审批')


class StartParam(SchemaBase):
    """发起表单审批"""

    code: str = Field(description='流程定义编码')
    form: dict[str, Any] = Field(default_factory=dict, description='表单数据')
    #: 节点 ID → 自选的审批人 ID 列表（字符串，硬纪律 6）
    selected: dict[str, list[str]] = Field(default_factory=dict, description='发起人自选的审批人')
    key: str = IdempotencyKey
    urgent: bool = Field(False, description='加急')
    #: 「重新发起」（内容来自旧单）时传 true：这次提交和这个流程的草稿无关，别把草稿删了
    keep_draft: bool = Field(False, description='提交后保留这个流程的草稿')


class PreviewParam(SchemaBase):
    """发起页的流程预告：按当前填的表单试算"""

    form: dict[str, Any] = Field(default_factory=dict, description='表单数据（可以没填完）')
    selected: dict[str, list[str]] = Field(default_factory=dict, description='已自选的审批人')


class ActionParam(SchemaBase):
    """对实例执行一个动作"""

    action: Action = Field(description='动作')
    key: str = IdempotencyKey
    opinion: str | None = Field(None, max_length=512, description='意见 / 原因')
    target_user_ids: list[SnowflakeIdIn] | None = Field(None, description='转办 / 抄送 / 改办理人的目标人')
    form: dict[str, Any] | None = Field(None, description='审批时修改的表单字段（只收本节点可编辑的）')
    target_node_id: str | None = Field(None, max_length=64, description='退回到哪个节点（发起人 = 开始节点 ID）')
    task_id: SnowflakeIdIn | None = Field(None, description='改办理人：改哪一条待办')
    resume: bool = Field(False, description='退回：重新提交 / 那一步办完之后直接回到退回的这一步')
    sign_mode: Literal['before', 'after'] | None = Field(None, description='加签：在我之前 / 在我之后')
    selected: dict[str, list[str]] | None = Field(None, description='被退回后重新提交：发起人自选的审批人')


class HandoverParam(SchemaBase):
    """离职交接：把一个人手上所有在办的待办交给另一个人"""

    from_user_id: SnowflakeIdIn = Field(description='交出待办的人')
    to_user_id: SnowflakeIdIn = Field(description='接手的人')
    key: str = IdempotencyKey


class DraftParam(SchemaBase):
    """存发起草稿（填到一半的表单，不校验内容）"""

    form: dict[str, Any] = Field(default_factory=dict, description='表单数据')
    ai_filled: list[str] = Field(default_factory=list, max_length=200, description='AI 填了、还没核对的字段 ID')
