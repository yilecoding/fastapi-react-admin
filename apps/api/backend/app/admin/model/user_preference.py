import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, DateTimeMixin, UniversalStr, UniversalText, id_key


# 个人偏好（#202）：一个人一个键一行。第一期只有工作台布局（`dashboard.layout`），
# 做成通用的是为了以后把主题 / 导览这些「跟人走、不跟设备走」的东西也搬上来。
#
# - `value` 是 **JSON 文本**，不用各方言的原生 JSON 类型：三个方言各不相同，而这一列只有
#   这里读（同 `sys_user_mfa.recovery_hashes`、`open_app.scopes`）。合法性和大小在写入侧
#   （`schema/user_preference.py`）拦，库里只会有一份 `json.dumps` 的产物
# - 不走软删除（`DataClassBase`）：「没有行 = 用默认值」，和 `sys_notification_pref` 同一个口径
# - `(user_id, key)` 两列都非空，普通唯一约束在三个方言上语义一致（不用 SQL Server 的筛选唯一索引）；
#   它的首列就是 `user_id`，按人查走得到这条索引，不再单独建
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class UserPreference(DataClassBase, DateTimeMixin):
    """用户个人偏好表"""

    __tablename__ = 'sys_user_preference'
    __table_args__ = (
        sa.UniqueConstraint('user_id', 'key', name='uq_sys_user_preference'),
        {'comment': '用户个人偏好表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    user_id: Mapped[int] = mapped_column(sa.BigInteger, comment='用户 ID')
    key: Mapped[str] = mapped_column(UniversalStr(64), comment='偏好键（如 dashboard.layout）')
    value: Mapped[str] = mapped_column(UniversalText, comment='偏好值（JSON 文本）')
