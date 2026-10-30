from datetime import datetime

from pydantic import ConfigDict, Field

from backend.common.enums import StatusType
from backend.common.pagination import PageData
from backend.common.schema import ColumnLengthChecked, SchemaBase, SnowflakeIdIn
from backend.plugin.notice.enums import NoticeLevel, NoticeType
from backend.plugin.notice.model import Notice
from backend.plugin.notification.enums import AudienceKind

#: 每条公告最多挂几个附件（#186）。读者那一侧是一张列表，挂上百个就没人翻得完了
NOTICE_ATTACHMENT_MAX = 20
#: 发布范围最多点多少项（#190）。校验时按 ID 批量查存不存在，SQL Server 一条语句最多 2100 个参数
NOTICE_AUDIENCE_MAX = 500


class NoticeSchemaBase(SchemaBase):
    """通知公告基础模型"""

    title: str = Field(description='标题')
    type: NoticeType = Field(description='类型（0：通知、1：公告）')
    status: StatusType = Field(description='状态（0：隐藏、1：显示）')
    content: str = Field(description='内容')
    pinned: bool = Field(False, description='是否置顶')
    level: NoticeLevel = Field(NoticeLevel.NORMAL, description='级别（0：普通、1：重要、2：紧急）')
    expire_time: datetime | None = Field(None, description='过期时间（为空不过期）')
    # #190
    popup: bool = Field(False, description='登录后弹窗')
    require_ack: bool = Field(False, description='必须点「我已阅读」（只在登录后弹窗时有意义）')
    publish_time: datetime | None = Field(None, description='定时发布时间（为空立即发布）')
    public: bool = Field(False, description='登录页可见（不登录也能看；不能有发布范围）')


class NoticeAudienceEntry(SchemaBase):
    """发布范围的一项（#190）：部门（含下级）/ 角色 / 用户"""

    kind: AudienceKind = Field(description='类型（dept：部门含下级、role：角色、user：用户）')
    target_id: SnowflakeIdIn = Field(description='部门 / 角色 / 用户 ID')


class NoticeAudienceItem(NoticeAudienceEntry):
    """发布范围的一项（带显示名）"""

    name: str | None = Field(None, description='部门 / 角色名称、用户昵称（对象已删除时为空）')


class NoticeWriteParam(ColumnLengthChecked, NoticeSchemaBase):
    """新增 / 修改共用的入参"""

    __sa_model__ = Notice

    # 附件跟着公告一起提交（#186）：原来要先保存、再去「查看」抽屉里传，
    # 而状态默认是「显示」—— 一保存就发了广播，读者收到通知的时候附件还没挂上。
    # None = 不动附件（只改了别的字段的旧调用方）；[] = 清空
    attachment_ids: list[int] | None = Field(
        None, max_length=NOTICE_ATTACHMENT_MAX, description='附件文件 ID（按顺序；为空不改附件）'
    )
    # 发布范围（#190）。语义同 `attachment_ids`：None = 不改（PUT 按 exclude_unset），[] = 全员
    audience: list[NoticeAudienceEntry] | None = Field(
        None, max_length=NOTICE_AUDIENCE_MAX, description='发布范围（为空不改；空列表 = 全员）'
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
    attachment_count: int = Field(0, description='附件个数')
    audience: list[NoticeAudienceItem] = Field([], description='发布范围（空 = 全员）')


class GetNoticeFeedItem(SchemaBase):
    """给所有登录用户看的公告（列表一行，不带正文）"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='通知公告 ID')
    title: str = Field(description='标题')
    type: NoticeType = Field(description='类型（0：通知、1：公告）')
    pinned: bool = Field(description='是否置顶')
    level: NoticeLevel = Field(description='级别（0：普通、1：重要、2：紧急）')
    expire_time: datetime | None = Field(None, description='过期时间')
    popup: bool = Field(False, description='登录后弹窗')
    require_ack: bool = Field(False, description='必须点「我已阅读」（打开时不自动标已读）')
    publish_time: datetime | None = Field(None, description='定时发布时间（为空 = 建好就发布了）')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')
    attachment_count: int = Field(0, description='附件个数')
    # 已读状态跟着收件箱那一行走（`sys_notification_read`），不另建一张已读表：
    # 铃铛、工作台看到的是同一份「读没读」。没有收件箱那一行（发布于 #186 之前、对不上的）算已读；
    # 建号之前发的算已读（新账号规则），但必须确认的（`require_ack`）只认点过「我已阅读」
    notification_id: int | None = Field(None, description='收件箱里对应那一行的 ID（标已读用）')
    read: bool = Field(True, description='当前用户是否已读')


class GetNoticeFeedDetail(GetNoticeFeedItem):
    """给所有登录用户看的公告详情（带正文）"""

    content: str = Field(description='内容')


class GetNoticePublicItem(SchemaBase):
    """登录页上的公告（不登录也能看，#190）。只给纯文本摘要：不带正文、附件、图"""

    id: int = Field(description='通知公告 ID')
    title: str = Field(description='标题')
    level: NoticeLevel = Field(description='级别（0：普通、1：重要、2：紧急）')
    pinned: bool = Field(description='是否置顶')
    # 定时发布的公告，读者看到的「发布时间」是它（`publish_time ?? created_time`，同读者列表的排序）。
    # 只给 created_time 的话，一条一周前建好、今天才到点的公告在登录页上写着一周前
    publish_time: datetime | None = Field(None, description='定时发布时间（为空表示建好即发布）')
    created_time: datetime = Field(description='创建时间')
    summary: str = Field(description='摘要（正文去掉标签后的纯文本，最多 200 字）')


class GetNoticeReader(SchemaBase):
    """阅读统计的一行（#190）"""

    user_id: int = Field(description='用户 ID')
    username: str = Field(description='用户名')
    nickname: str = Field(description='昵称')
    dept_name: str | None = Field(None, description='部门名称')
    read_time: datetime | None = Field(None, description='阅读时间（未读为空）')


class GetNoticeReadsPage(PageData[GetNoticeReader]):
    """阅读统计：当前页签（已读 / 未读）的分页 + 两个页签各自的人数

    分页的 `total` 是当前页签的条数；两个计数不管看哪个页签都一起给，界面上两个页签的数字一次拿齐
    """

    read_count: int = Field(description='已读人数')
    unread_count: int = Field(description='未读人数（发布范围内、启用的账号里还没读的）')
