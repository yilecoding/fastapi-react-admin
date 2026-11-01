from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model.user_preference import UserPreference
from backend.common.security.data_scope import DataScopedCRUD


class CRUDUserPreference(DataScopedCRUD[UserPreference]):
    """用户个人偏好数据库操作类"""

    #: 显式豁免数据权限 —— 「我的偏好」，每条查询都强制按 `request.user.id` 过滤（同通知偏好 / 收件箱），
    #: 不存在「看别人的偏好」这条路径
    data_scope_enabled = False

    async def get_one(self, db: AsyncSession, *, user_id: int, key: str) -> UserPreference | None:
        return await db.scalar(
            select(UserPreference).where(UserPreference.user_id == user_id, UserPreference.key == key)
        )

    async def count_keys(self, db: AsyncSession, *, user_id: int) -> int:
        return (
            await db.scalar(select(func.count()).select_from(UserPreference).where(UserPreference.user_id == user_id))
            or 0
        )

    async def save(
        self, db: AsyncSession, *, existing: UserPreference | None, user_id: int, key: str, value: str
    ) -> UserPreference:
        """有就改、没有就插（`existing` 是调用方刚 `get_one` 出来的那一行）。

        ⚠️ 三个方言的 upsert 语法各不相同（`MERGE` / `ON CONFLICT` / `ON DUPLICATE KEY`），这里是
        先查后写。同一个人同一个键**第一次**被两个请求同时写，后到的那个会撞 `(user_id, key)` 唯一约束
        —— 只可能是同一个人在两个设备上同一瞬间第一次保存，接受；撞了是一次失败的保存，不会写坏数据
        """
        row = existing
        if row is None:
            row = UserPreference(user_id=user_id, key=key, value=value)
            db.add(row)
        else:
            row.value = value
        await db.flush()
        await db.refresh(row)
        return row


user_preference_dao: CRUDUserPreference = CRUDUserPreference(UserPreference)
