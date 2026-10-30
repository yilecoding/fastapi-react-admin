from datetime import datetime

from pydantic import ConfigDict, Field

from backend.common.enums import StatusType
from backend.common.schema import ColumnLengthChecked, SchemaBase
from backend.plugin.notice.enums import NoticeLevel, NoticeType
from backend.plugin.notice.model import Notice

#: 每条公告最多挂几个附件（#186）。读者那一侧是一张列表，挂上百个就没人翻得完了
NOTICE_ATTACHMENT_MAX = 20


class NoticeSchemaBase(SchemaBase):
    """通知公告基础模型"""

    title: str = Field(description='标题')
    type: NoticeType = Field(description='类型（0：通知、1：公告）')
    status: StatusType = Field(description='状态（0：隐藏、1：显示）')
    content: str = Field(description='内容')
    pinned: bool = Field(False, description='是否置顶')
    level: NoticeLevel = Field(NoticeLevel.NORMAL, description='级别（0：普通、1：重要、2：紧急）')
    expire_time: datetime | None = Field(None, description='过期时间（为空不过期）')


class NoticeWriteParam(ColumnLengthChecked, NoticeSchemaBase):
    """新增 / 修改共用的入参"""

    __sa_model__ = Notice

    # 附件跟着公告一起提交（#186）：原来要先保存、再去「查看」抽屉里传，
    # 而状态默认是「显示」—— 一保存就发了广播，读者收到通知的时候附件还没挂上。
    # None = 不动附件（只改了别的字段的旧调用方）；[] = 清空
    attachment_ids: list[int] | None = Field(
        None, max_length=NOTICE_ATTACHMENT_MAX, description='附件文件 ID（按顺序；为空不改附件）'
    )


class CreateNoticeParam(NoticeWriteParam):
    """创建通知公告参数"""


class UpdateNoticeParam(NoticeWriteParam):
    """更新通知公告参数"""


class DeleteNoticeParam(SchemaBase):
    """删除通知公告参数"""

    pks: list[int] = Field(description='通知公告 ID 列表')


class GetNoticeDetail(NoticeSchemaBase):
    """通知公告详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='通知公告 ID')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')


class GetNoticeFeedItem(SchemaBase):
    """给所有登录用户看的公告（列表一行，不带正文）"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='通知公告 ID')
    title: str = Field(description='标题')
    type: NoticeType = Field(description='类型（0：通知、1：公告）')
    pinned: bool = Field(description='是否置顶')
    level: NoticeLevel = Field(description='级别（0：普通、1：重要、2：紧急）')
    expire_time: datetime | None = Field(None, description='过期时间')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')
    attachment_count: int = Field(0, description='附件个数')
    # 已读状态跟着收件箱那一行走（`sys_notification_read`），不另建一张已读表：
    # 铃铛、工作台看到的是同一份「读没读」。没有收件箱那一行（发布于 #186 之前、对不上的）算已读
    notification_id: int | None = Field(None, description='收件箱里对应那一行的 ID（标已读用）')
    read: bool = Field(True, description='当前用户是否已读')


class GetNoticeFeedDetail(GetNoticeFeedItem):
    """给所有登录用户看的公告详情（带正文）"""

    content: str = Field(description='内容')
