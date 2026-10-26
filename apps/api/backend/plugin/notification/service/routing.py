"""路由：一条通知该走哪几条外部渠道 = 系统策略 × 个人偏好 × 有没有地址（#166 第二、三节）。

只做决定，不发东西。决定在调用方的事务里做、结果落成投递行；worker 只按行发，不再问「该不该发」。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select

from backend.app.admin.model import User
from backend.plugin.core import check_plugin_installed
from backend.plugin.notification.crud.crud_channel import notification_policy_dao, notification_pref_dao
from backend.plugin.notification.enums import EXTERNAL_CHANNELS, NotificationChannel, PolicyMode

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.plugin.notification.kinds import NotificationKind

#: 渠道 → 它靠哪个插件发。插件没装：那条渠道照样记一行 skipped，投递记录页上看得到「没发，因为没装短信插件」
_CHANNEL_PLUGIN: dict[NotificationChannel, str] = {
    NotificationChannel.email: 'email',
    NotificationChannel.sms: 'sms',
}


@dataclass(frozen=True, slots=True)
class Route:
    """一个人 × 一条外部渠道的决定。`reason` 有值 = 记一行 skipped、不发"""

    user_id: int
    channel: NotificationChannel
    address: str | None
    reason: str | None = None


def effective_modes(kind: NotificationKind, overrides: Mapping[str, str]) -> dict[NotificationChannel, PolicyMode]:
    """注册表默认值 + 库里的覆盖。库里那一格的渠道这个类型不支持（类型改过定义）就忽略那一格"""
    modes = dict(kind.defaults)
    for channel, mode in overrides.items():
        try:
            ch, md = NotificationChannel(channel), PolicyMode(mode)
        except ValueError:
            continue
        if ch in modes and ch is not NotificationChannel.inapp:
            modes[ch] = md
    return modes


def wants(mode: PolicyMode, *, pref: bool | None, configurable: bool) -> bool:
    """策略四态 × 个人偏好 → 走不走"""
    if mode is PolicyMode.off:
        return False
    if mode is PolicyMode.forced:
        return True
    if not configurable or pref is None:
        return mode is PolicyMode.default_on
    return pref


async def policy_overrides(db: AsyncSession, kind: str) -> dict[str, str]:
    return {p.channel: p.mode for p in await notification_policy_dao.get_all(db, [kind])}


async def resolve(db: AsyncSession, kind: NotificationKind, user_ids: Sequence[int]) -> list[Route]:
    """算出外部渠道的投递清单。站内不在这里（站内行由调用方直接写）"""
    if not user_ids or kind.broadcast:
        return []
    modes = effective_modes(kind, await policy_overrides(db, kind.code))
    external = [c for c in EXTERNAL_CHANNELS if c in modes and modes[c] is not PolicyMode.off]
    if not external:
        return []

    prefs: dict[tuple[int, str], bool] = {
        (p.user_id, p.channel): p.enabled for p in await notification_pref_dao.get_for_users(db, user_ids, kind.code)
    }
    users = {
        u.id: u
        for u in (
            await db.execute(select(User.id, User.email, User.phone, User.status).where(User.id.in_(list(user_ids))))
        ).all()
    }

    routes: list[Route] = []
    for uid in dict.fromkeys(user_ids):
        user = users.get(uid)
        if user is None:
            # 人删了（雪花 ID 指向空）：没有可记的地址，也不值得一行 skipped
            continue
        for channel in external:
            pref = prefs.get((uid, channel.value))
            if not wants(modes[channel], pref=pref, configurable=kind.user_configurable):
                continue
            address = user.email if channel is NotificationChannel.email else user.phone
            reason: str | None = None
            if user.status != 1:
                reason = 'user_disabled'
            elif not check_plugin_installed(_CHANNEL_PLUGIN[channel]):
                reason = 'plugin_missing'
            elif not address:
                # 🔴 缺地址不是静默跳过：记一行 skipped，投递记录页能看到「这 37 个人没邮箱」（硬纪律 9）
                reason = 'no_address'
            routes.append(Route(user_id=uid, channel=channel, address=address or None, reason=reason))
    return routes
