from backend.common.enums import IntEnum


class NoticeType(IntEnum):
    """通知公告类型"""

    NOTICE = 0
    ANNOUNCEMENT = 1


class NoticeLevel(IntEnum):
    """通知公告级别"""

    NORMAL = 0
    IMPORTANT = 1
    URGENT = 2
