from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, DateTimeMixin, TimeZone, UniversalStr, UniversalText, id_key


# 群机器人（#166 二期）：飞书 / 钉钉 / 企业微信群里的「自定义机器人」，订阅几类通知，有一条就往群里推一条。
#
# 🔴 **Webhook 地址本身就是凭据**（飞书的 hook ID、钉钉的 access_token、企微的 key —— 拿到地址就能往群里发），
# 所以地址和加签密钥一样**加密存**（`NOTIFICATION_ENCRYPT_SECRET_KEY`），接口只给 `webhook_hint`。
#
# 硬删、不走逻辑删除（同 Webhook 端点）：删了的机器人没有「还原」的需要；它的投递记录照留（`bot_name` 快照）
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class NotificationBot(DataClassBase, DateTimeMixin):
    """通知群机器人表"""

    __tablename__ = 'sys_notification_bot'

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='名称（投递记录里显示的就是它）')
    platform: Mapped[str] = mapped_column(UniversalStr(16), comment='平台（feishu / dingtalk / wecom）')
    webhook_cipher: Mapped[str] = mapped_column(UniversalText, comment='Webhook 地址密文（AES；地址本身就是凭据）')
    webhook_hint: Mapped[str] = mapped_column(UniversalStr(128), comment='Webhook 地址掩码（只用于辨认）')
    kinds: Mapped[str] = mapped_column(UniversalText, comment='订阅的通知类型码 JSON 数组')
    secret_cipher: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='加签密钥密文（飞书 / 钉钉的「签名校验」；没开就为空）'
    )
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    remark: Mapped[str | None] = mapped_column(UniversalStr(256), default=None, comment='备注')
    last_sent_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='最近一次发送成功的时间')
    last_error: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='最近一次失败的原因（成功后清空）'
    )
    created_by: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='创建者 ID')
