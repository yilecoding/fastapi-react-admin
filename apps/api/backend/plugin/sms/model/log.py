from datetime import datetime

from sqlalchemy import BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone

# 发送日志（对标 ContiNew 的 `sys_sms_log`，但**失败也记**：ContiNew 只在 SMS4J 的成功钩子里写日志，
# 网络失败不落日志）。两段式：发送前插一行「发送中」并提交，发完更新成终态（`service/sms_service.py`）。
#
# - `id` **发送前生成**，同时作为流水号传给厂商（阿里云 `OutId` / 腾讯云 `SessionContext`），在厂商控制台按它能对上
# - `provider` 冗余一份：配置删了日志还读得懂
# - `phone` 完整存；**列表接口掩码**，详情接口给完整号
# - `params` 里声明为敏感的参数已打码
# - 不走软删除（`DataClassBase`）：审计记录只按保留期清理
#
# ⚠️ 类 docstring 保持一行（表注释）。
#: 厂商模板 ID 的列宽；保存配置和发测试短信时都按它拦（超了会在插日志那一步 DataError）
TEMPLATE_ID_MAX_LEN = 64


class SmsLog(DataClassBase):
    """短信发送日志表"""

    __tablename__ = 'sms_log'

    id: Mapped[id_key] = mapped_column(init=False)
    provider: Mapped[str] = mapped_column(UniversalStr(32), comment='厂商码（冗余，配置删了还读得懂）')
    phone: Mapped[str] = mapped_column(UniversalStr(32), index=True, comment='手机号（完整存，列表接口掩码）')
    template: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='业务模板码（测试短信为 test）')
    status: Mapped[int] = mapped_column(index=True, comment='状态（0 失败 · 1 已受理 · 2 结果未知 · 3 发送中）')
    config_id: Mapped[int | None] = mapped_column(BigInteger, index=True, default=None, comment='走的哪条配置')
    template_id: Mapped[str | None] = mapped_column(
        UniversalStr(TEMPLATE_ID_MAX_LEN), default=None, comment='厂商模板 ID'
    )
    params: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='厂商侧参数 JSON（敏感参数已打码）')
    error_kind: Mapped[str | None] = mapped_column(
        UniversalStr(32), index=True, default=None, comment='错误类型（SmsErrorKind）'
    )
    provider_code: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='厂商原始错误码')
    provider_msg: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='厂商原始文案 / 异常文本')
    request_id: Mapped[str | None] = mapped_column(UniversalStr(128), default=None, comment='厂商请求 ID')
    biz_id: Mapped[str | None] = mapped_column(
        UniversalStr(128), default=None, comment='厂商回执 ID（阿里云 BizId / 腾讯云 SerialNo）'
    )
    duration_ms: Mapped[int | None] = mapped_column(default=None, comment='请求耗时（毫秒）')
    created_by: Mapped[int | None] = mapped_column(BigInteger, default=None, comment='发起人 ID（匿名接口为空）')
    # index：列表按它排序筛选、清理任务按它做范围删除（同 open_api_log.request_time）
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, index=True, comment='创建时间'
    )
    updated_time: Mapped[datetime | None] = mapped_column(TimeZone, init=False, default=None, comment='更新时间')
