"""审批流的六张表（issue #107 设计 3）

刻意砍掉的（参与人表 / 模板按组织命中 / outbox / 审批规则表）见 issue 正文。
"""

from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.enums import DataBaseType
from backend.common.model import Base, DataClassBase, DateTimeMixin, TimeZone, UniversalStr, UniversalText, id_key
from backend.core.conf import settings
from backend.utils.timezone import timezone

# 「一张单据同一时刻只有一个运行中实例」：运行中时 active_key 有值、到终态置 NULL，
# 再加唯一约束。MySQL / PG 的唯一列允许多个 NULL；SQL Server 不允许（它把 NULL
# 当成相等），要改成筛选唯一索引 —— 和 `sys_user` 的 `_EMAIL_UNIQUE` 同一个写法。
# 表单审批（biz_type='form'）的 active_key 恒为 NULL：一张表单就是一个实例，没有「重提」。
_ACTIVE_KEY_UNIQUE = (
    sa.Index('uk_wf_instance_active_key', 'active_key', unique=True, mssql_where=sa.text('active_key IS NOT NULL'))
    if DataBaseType.sqlserver == settings.DATABASE_TYPE
    else sa.UniqueConstraint('active_key', name='uk_wf_instance_active_key')
)


class WfDefinition(Base):
    """流程定义表"""

    __tablename__ = 'wf_definition'
    __table_args__ = (
        sa.UniqueConstraint('code', 'deleted', name='uk_wf_definition_code_deleted'),
        {'comment': '流程定义表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    code: Mapped[str] = mapped_column(UniversalStr(64), comment='编码（稳定引用键，创建后不可改）')
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='名称')
    biz_type: Mapped[str] = mapped_column(UniversalStr(64), comment='业务类型（form = 表单审批）')
    category: Mapped[str | None] = mapped_column(UniversalStr(32), default=None, comment='分组（发起页按它分栏）')
    icon: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='图标')
    description: Mapped[str | None] = mapped_column(UniversalStr(256), default=None, comment='说明')
    status: Mapped[str] = mapped_column(UniversalStr(16), default='draft', comment='draft / published / disabled')
    # 草稿：编辑永远在这两列上做。发布 = 把它们原样拷进一条新的 version 行
    draft_form_json: Mapped[str] = mapped_column(
        UniversalText, default='{"schemaVersion":1,"fields":[]}', comment='表单草稿'
    )
    draft_model_json: Mapped[str] = mapped_column(
        UniversalText,
        default='{"schemaVersion":1,"root":{"type":"start","id":"start","next":null}}',
        comment='流程草稿',
    )
    current_version_id: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='当前已发布版本 ID')
    sort: Mapped[int] = mapped_column(default=0, comment='排序')


class WfDefinitionVersion(DataClassBase, DateTimeMixin):
    """流程定义版本表 —— 发布后只读"""

    __tablename__ = 'wf_definition_version'
    __table_args__ = (
        sa.UniqueConstraint('definition_id', 'version_no', name='uk_wf_definition_version_no'),
        {'comment': '流程定义版本表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    definition_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='流程定义 ID')
    version_no: Mapped[int] = mapped_column(comment='版本号')
    # 表单和流程存在同一个版本里一起发布（#107 设计 6.5）：分开存版本就会出现
    # 「表单 v3 + 流程 v2」，条件节点引用的字段可能根本不存在
    form_json: Mapped[str] = mapped_column(UniversalText, comment='表单 schema（唯一真源）')
    model_json: Mapped[str] = mapped_column(UniversalText, comment='流程模型（唯一真源）')
    published_by: Mapped[int] = mapped_column(sa.BigInteger, comment='发布人')


class WfInstance(DataClassBase, DateTimeMixin):
    """审批实例表"""

    __tablename__ = 'wf_instance'
    __table_args__ = (_ACTIVE_KEY_UNIQUE, {'comment': '审批实例表'})

    id: Mapped[id_key] = mapped_column(init=False)
    definition_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='流程定义 ID')
    version_id: Mapped[int] = mapped_column(sa.BigInteger, comment='发起时的定义版本 ID')
    biz_type: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='业务类型')
    biz_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='业务单据 ID（表单审批为空）')
    seq: Mapped[int] = mapped_column(comment='同一单据第几次送审')
    title: Mapped[str] = mapped_column(UniversalStr(128), comment='标题')
    summary: Mapped[str | None] = mapped_column(UniversalStr(512), comment='摘要')
    initiator_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='发起人')
    initiator_dept_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='发起时所在部门')
    status: Mapped[str] = mapped_column(UniversalStr(16), index=True, comment='running / approved / …')
    current_node_id: Mapped[str | None] = mapped_column(
        UniversalStr(64), comment='当前所在节点（无并行分支，只有一个）'
    )
    # 原样保存的快照：校验只读不写回（avc-bp 第 1 条教训：解析再序列化会丢字段）
    form_snapshot: Mapped[str] = mapped_column(UniversalText, comment='表单 schema 快照')
    model_snapshot: Mapped[str] = mapped_column(UniversalText, comment='流程模型快照')
    form_data: Mapped[str] = mapped_column(UniversalText, comment='表单数据（JSON）')
    variables: Mapped[str] = mapped_column(UniversalText, comment='发起时决定的东西（自选审批人等，JSON）')
    # 乐观锁：所有改实例状态的动作都先 `UPDATE ... WHERE version=?`，它同时是这张单的互斥点
    version: Mapped[int] = mapped_column(default=0, comment='版本号（乐观锁）')
    active_key: Mapped[str | None] = mapped_column(
        UniversalStr(128), default=None, comment='运行中时 = biz_type:biz_id'
    )
    finished_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='结束时间')
    #: 发起人标的「加急」：待办列表排在前面、带标记。只是提示，不改流程
    urgent: Mapped[bool] = mapped_column(default=False, comment='加急')


class WfTask(DataClassBase, DateTimeMixin):
    """待办表 —— 一人一行：会签 3 人就是同一个 node_id 下的 3 行"""

    __tablename__ = 'wf_task'
    __table_args__ = (
        sa.Index('ix_wf_task_assignee_status', 'assignee_id', 'status'),
        {'comment': '待办表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    instance_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='实例 ID')
    node_id: Mapped[str] = mapped_column(UniversalStr(64), comment='节点 ID')
    node_name: Mapped[str] = mapped_column(UniversalStr(64), comment='节点名称（快照）')
    assignee_id: Mapped[int] = mapped_column(sa.BigInteger, comment='办理人')
    # 人改名或被删之后历史照样能显示（#107 设计 2）
    assignee_name: Mapped[str] = mapped_column(UniversalStr(64), comment='办理人姓名（快照）')
    origin_assignee_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='转办前的办理人')
    status: Mapped[str] = mapped_column(UniversalStr(16), comment='pending / done / canceled / transferred')
    decision: Mapped[str | None] = mapped_column(UniversalStr(16), default=None, comment='approve / reject')
    opinion: Mapped[str | None] = mapped_column(UniversalStr(512), default=None, comment='意见')
    version: Mapped[int] = mapped_column(default=0, comment='版本号（乐观锁）')
    #: 同一个节点可能走不止一次（退回之后重走）。进入节点那一刻实例的 version 当轮次号：
    #: 一次进入里建的待办（含之后转交 / 依次审批轮到的）都是同一个值。
    #: 「这一步谁已经同意过」「这一步还剩几个人」都只能在同一轮里数 —— 不分的话，上一轮
    #: 同意过的人会被当成这一轮已经表过态
    batch: Mapped[int] = mapped_column(default=0, comment='进入节点的轮次（退回后重走同一节点时不同）')
    finished_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='办结时间')
    #: 办理人第一次打开这张单的时间（「已读」）。发起人能看出「他看过了还没批」和「他根本没看到」
    read_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='办理人已读时间')


class WfActionRecord(DataClassBase):
    """动作记录表（轨迹兼审计）—— 被拒绝的动作也记"""

    __tablename__ = 'wf_action_record'
    __table_args__ = (
        sa.UniqueConstraint('idempotency_key', name='uk_wf_action_record_idem'),
        {'comment': '动作记录表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    instance_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='实例 ID')
    task_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='关联待办')
    node_id: Mapped[str | None] = mapped_column(UniversalStr(64), comment='节点 ID')
    node_name: Mapped[str | None] = mapped_column(UniversalStr(64), comment='节点名称（快照）')
    action: Mapped[str] = mapped_column(UniversalStr(32), comment='动作（含 start / skip / auto_reject 等系统动作）')
    actor_type: Mapped[str] = mapped_column(UniversalStr(16), comment='user / system')
    actor_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='操作人')
    actor_name: Mapped[str | None] = mapped_column(UniversalStr(64), comment='操作人姓名（快照）')
    target_user_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='目标人（转办 / 抄送）')
    target_user_name: Mapped[str | None] = mapped_column(UniversalStr(256), comment='目标人姓名（快照）')
    opinion: Mapped[str | None] = mapped_column(UniversalStr(512), comment='意见 / 原因')
    result: Mapped[str] = mapped_column(UniversalStr(16), comment='ok / rejected')
    reject_reason: Mapped[str | None] = mapped_column(UniversalStr(256), comment='被拒绝的原因')
    idempotency_key: Mapped[str] = mapped_column(UniversalStr(64), comment='幂等键')
    detail: Mapped[str | None] = mapped_column(UniversalText, comment='补充信息（JSON，如表单改动前后）')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, comment='创建时间'
    )


class WfCc(DataClassBase):
    """抄送表"""

    __tablename__ = 'wf_cc'
    __table_args__ = (
        sa.UniqueConstraint('instance_id', 'user_id', name='uk_wf_cc_instance_user'),
        {'comment': '抄送表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    instance_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='实例 ID')
    user_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='被抄送人')
    node_id: Mapped[str | None] = mapped_column(UniversalStr(64), comment='来源节点（手动抄送为办理人所在节点）')
    from_user_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='谁抄送的（流程节点为空）')
    read_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='已读时间')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, comment='创建时间'
    )


class WfDraft(DataClassBase, DateTimeMixin):
    """发起草稿：一个人、一个流程一份。填一半关掉抽屉，下次打开还在；提交成功即删"""

    __tablename__ = 'wf_draft'
    __table_args__ = (
        sa.UniqueConstraint('user_id', 'code', name='uk_wf_draft_user_code'),
        {'comment': '发起草稿表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    user_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='谁的草稿')
    code: Mapped[str] = mapped_column(UniversalStr(64), comment='流程定义编码')
    form_data: Mapped[str] = mapped_column(UniversalText, comment='没提交的表单（JSON）')
    #: 哪些字段是 AI 填的、发起人还没核对（#111 第 3 条）。跟着草稿存：只放在界面状态里的话，关掉再打开
    #: 值还在、标记没了 —— AI 填的值看起来就和自己填的一样
    ai_filled: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='AI 填了、还没核对的字段 ID（JSON 数组）'
    )


class WfAiReview(DataClassBase, DateTimeMixin):
    """AI 预审（#111 第 2 条）：实例提交 / 重新提交后异步跑一次，只供审批人参考。

    一次提交一行。重新提交会新建一行，界面只看最新那一行（旧的就是「已过期」）。
    🔴 这张表只有预审自己写 —— 审批事务里只插一行 `pending`，模型调用在 Celery 里、事务外。
    """

    __tablename__ = 'wf_ai_review'
    __table_args__ = {'comment': 'AI 预审表'}

    id: Mapped[id_key] = mapped_column(init=False)
    instance_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='实例 ID')
    status: Mapped[str] = mapped_column(UniversalStr(16), comment='pending / done / failed')
    #: 按哪一版审核要点审的（要点原文的 sha256 前 12 位）。定义改了要点，旧结论还能对上当时的依据
    points_version: Mapped[str] = mapped_column(UniversalStr(16), comment='审核要点版本')
    verdict: Mapped[str | None] = mapped_column(UniversalStr(16), default=None, comment='pass / attention / reject')
    #: `[{field_id, text}]`。field_id 为空 = 不针对某个字段的整体意见
    reasons: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='理由（JSON）')
    error: Mapped[str | None] = mapped_column(UniversalStr(512), default=None, comment='失败原因')
    # 审计（#111 不变式 5）：能回答「这条建议是哪个模型、基于哪版要点、花了多少给的」
    model: Mapped[str | None] = mapped_column(UniversalStr(128), default=None, comment='模型名')
    duration_ms: Mapped[int | None] = mapped_column(default=None, comment='耗时（毫秒）')
    prompt_tokens: Mapped[int | None] = mapped_column(default=None, comment='输入 token')
    completion_tokens: Mapped[int | None] = mapped_column(default=None, comment='输出 token')
    finished_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='完成时间')
    attachments: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='给模型读了哪些附件（JSON：字段 · 文件 ID · sha256 · 读没读出来）'
    )
    #: 提交那一刻实例的版本号（#111 第 5 条）。AI 自动同意只在「提交之后谁都没动过」时才做：
    #: 预审审的是提交时的内容，之后有人改过 / 推进过，这个结论就不是针对现在这张单的了
    instance_version: Mapped[int | None] = mapped_column(default=None, comment='提交时的实例版本号')


class WfAiAssist(DataClassBase, DateTimeMixin):
    """设计器一句话生成 / 发起时自动填单（#111 第 1、3 条）的模型调用记录 —— 只为不变式 5（可审计）。

    结果不存：生成的定义只进设计器草稿、填的值只进发起草稿，人确认之后才变成数据。
    🔴 也**不存输入原文**：填单的输入是发票 / 一段话，可能带个人信息；这张表要回答的只是
    「哪个模型、哪版提示词、花了多少、成没成」。
    """

    __tablename__ = 'wf_ai_assist'
    __table_args__ = {'comment': 'AI 辅助调用记录'}

    id: Mapped[id_key] = mapped_column(init=False)
    kind: Mapped[str] = mapped_column(UniversalStr(16), comment='design / fill')
    user_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='谁发起的')
    definition_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='哪个流程定义')
    status: Mapped[str] = mapped_column(UniversalStr(16), comment='done / failed')
    prompt_version: Mapped[str] = mapped_column(UniversalStr(16), comment='提示词版本')
    #: 调了几次模型（生成之后按校验结果回喂修一轮 = 2）
    rounds: Mapped[int] = mapped_column(comment='调用轮数')
    model: Mapped[str | None] = mapped_column(UniversalStr(128), default=None, comment='模型名')
    duration_ms: Mapped[int | None] = mapped_column(default=None, comment='耗时（毫秒）')
    prompt_tokens: Mapped[int | None] = mapped_column(default=None, comment='输入 token')
    completion_tokens: Mapped[int | None] = mapped_column(default=None, comment='输出 token')
    error: Mapped[str | None] = mapped_column(UniversalStr(512), default=None, comment='失败原因')
