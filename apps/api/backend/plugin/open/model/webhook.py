from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, DateTimeMixin, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


# Webhook 端点（#167）：外部系统登记一个 URL + 想听的事件，事件发生后这边带签名 POST 过去。
#
# 🔴 **密钥加密存、不是哈希**（同 SK）：每次投递都要拿它重算签名。详情 / 列表里只给 `secret_hint`。
# 重置密钥后旧密钥留 24 小时、这期间**两把都签**（Standard Webhooks 允许一次带多个签名做无停机轮换）。
#
# 硬删、不走逻辑删除：删了的端点没有「还原」的需要，留着只会让 fan-out 的查询多一个条件
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class OpenWebhook(DataClassBase, DateTimeMixin):
    """能力开放 Webhook 端点表"""

    __tablename__ = 'open_webhook'

    id: Mapped[id_key] = mapped_column(init=False)
    app_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='所属应用 ID')
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='端点名称')
    url: Mapped[str] = mapped_column(UniversalStr(512), comment='接收地址')
    secret_cipher: Mapped[str] = mapped_column(UniversalText, comment='签名密钥密文（AES）')
    secret_hint: Mapped[str] = mapped_column(UniversalStr(24), comment='签名密钥前几位（只用于辨认）')
    events: Mapped[str] = mapped_column(UniversalText, comment='订阅的事件类型 JSON 数组（支持 user.* 前缀通配）')
    secret_prev_cipher: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='轮换前的旧密钥密文（过期前两把都签）'
    )
    secret_prev_expire_time: Mapped[datetime | None] = mapped_column(
        TimeZone, default=None, comment='旧密钥停止签名的时间'
    )
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    disabled_reason: Mapped[str | None] = mapped_column(
        UniversalStr(16), default=None, comment='停用原因（manual / auto / gone）'
    )
    disabled_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='停用时间')
    consecutive_failures: Mapped[int] = mapped_column(default=0, comment='连续失败次数（成功一次清零）')
    first_failure_time: Mapped[datetime | None] = mapped_column(
        TimeZone, default=None, comment='这一轮连续失败的第一次时间'
    )
    last_delivery_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='最近一次投递时间')
    last_success_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='最近一次成功时间')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
    created_by: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='创建者 ID')


# 事件本身（outbox）。`id` 就是对外的 `webhook-id`：重试不变，对方拿它去重。
#
# 🔴 `payload` 是**要发出去的那份 body 原文**：生成一次、签它、发它，重试也发同一份 —— 不许中间再序列化一次
# （Standard Webhooks 特别警告的那条：两次序列化的字节不一定相同，签名就对不上了）。
# 没有任何端点订阅的事件也照写（审计 + 二期「回放」的底），按保留天数清理。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class OpenEvent(DataClassBase):
    """能力开放事件表"""

    __tablename__ = 'open_event'

    id: Mapped[id_key] = mapped_column(init=False)
    type: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='事件类型（dept.updated…）')
    aggregate_id: Mapped[int | None] = mapped_column(sa.BigInteger, index=True, comment='事件主体的 ID')
    payload: Mapped[str] = mapped_column(UniversalText, comment='请求体原文（JSON，签名就签这一份）')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, index=True, default_factory=timezone.now, comment='创建时间'
    )


# 一个事件 × 一个端点 = 一条投递。fan-out 在**事件产生时**做（端点后加进来的不该收到历史事件，同 Svix）。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class OpenWebhookDelivery(DataClassBase, DateTimeMixin):
    """能力开放 Webhook 投递表"""

    __tablename__ = 'open_webhook_delivery'
    __table_args__ = (
        sa.Index('ix_open_webhook_delivery_due', 'status', 'next_attempt_time'),
        # 每天的清理按它分批删（`maintenance.prune_logs`）；它来自 DateTimeMixin，自己不带索引
        sa.Index('ix_open_webhook_delivery_created_time', 'created_time'),
        {'comment': '能力开放 Webhook 投递表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    webhook_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='端点 ID')
    event_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='事件 ID（= webhook-id）')
    event_type: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='事件类型（冗余，列表筛选用）')
    status: Mapped[str] = mapped_column(
        UniversalStr(16), comment='状态（pending / sending / success / failed / exhausted）'
    )
    attempts: Mapped[int] = mapped_column(default=0, comment='已尝试次数')
    next_attempt_time: Mapped[datetime | None] = mapped_column(
        TimeZone, default=None, comment='下一次尝试的时间（不会再试时为空）'
    )
    last_response_code: Mapped[int | None] = mapped_column(default=None, comment='最近一次的 HTTP 状态码')
    last_error: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='最近一次的错误')
    last_duration_ms: Mapped[int | None] = mapped_column(default=None, comment='最近一次的耗时（毫秒）')
    success_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='成功的时间')


# 每一次 HTTP 尝试一行：对接排查看的就是这个（发了什么头、对方回了什么）。
# 签名值打码；响应体脱敏 + 截断直接用 `OperaLogMiddleware` 的静态方法（`open/AGENTS.md`：别另写一份）。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class OpenWebhookAttempt(DataClassBase):
    """能力开放 Webhook 投递尝试表"""

    __tablename__ = 'open_webhook_attempt'

    id: Mapped[id_key] = mapped_column(init=False)
    delivery_id: Mapped[int] = mapped_column(sa.BigInteger, index=True, comment='投递 ID')
    attempt: Mapped[int] = mapped_column(comment='第几次尝试（从 1 起）')
    url: Mapped[str] = mapped_column(UniversalStr(512), comment='这次发往的地址')
    request_headers: Mapped[str | None] = mapped_column(sa.JSON(), comment='请求头（签名已打码）')
    response_code: Mapped[int | None] = mapped_column(comment='HTTP 状态码（没收到响应为空）')
    response_headers: Mapped[str | None] = mapped_column(sa.JSON(), comment='响应头')
    response_body: Mapped[str | None] = mapped_column(UniversalText, comment='响应体（脱敏 + 截断）')
    error: Mapped[str | None] = mapped_column(UniversalText, comment='错误（超时 / 连接失败 / 地址被拦）')
    duration_ms: Mapped[int] = mapped_column(comment='耗时（毫秒）')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, index=True, default_factory=timezone.now, comment='尝试时间'
    )
