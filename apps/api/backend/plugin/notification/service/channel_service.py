"""系统策略矩阵 / 个人偏好矩阵的读写（#166 第二、三、八节）"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from backend.app.admin.model import User
from backend.common.exception import errors
from backend.common.i18n import t
from backend.plugin.notification.crud.crud_channel import notification_policy_dao, notification_pref_dao
from backend.plugin.notification.enums import NotificationChannel, PolicyMode
from backend.plugin.notification.extensions import load_notification_extensions
from backend.plugin.notification.kinds import NotificationKind, get_notification_kind, list_notification_kinds
from backend.plugin.notification.service.routing import effective_modes, wants

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.plugin.notification.schema.channel import UpdatePoliciesParam, UpdatePrefsParam


def _kinds() -> list[NotificationKind]:
    load_notification_extensions()
    return list_notification_kinds()


def _require_kind(code: str) -> NotificationKind:
    load_notification_extensions()
    kind = get_notification_kind(code)
    if kind is None:
        raise errors.RequestError(msg=t('error.notification.kind_not_found', kind=code))
    return kind


class ChannelService:
    @staticmethod
    async def get_policies(db: AsyncSession) -> list[dict[str, Any]]:
        overrides: dict[str, dict[str, str]] = {}
        for p in await notification_policy_dao.get_all(db):
            overrides.setdefault(p.kind, {})[p.channel] = p.mode
        out = []
        for kind in _kinds():
            modes = effective_modes(kind, overrides.get(kind.code, {}))
            out.append({
                'kind': kind.code,
                'label': kind.label,
                'category': kind.category.value,
                'broadcast': kind.broadcast,
                'user_configurable': kind.user_configurable,
                'cells': [
                    {
                        'channel': ch.value,
                        'mode': modes[ch].value,
                        'default': kind.defaults[ch].value,
                        # 站内一律 forced、不让改（收件箱的事实来源）
                        'editable': ch is not NotificationChannel.inapp,
                    }
                    for ch in kind.channels
                ],
            })
        return out

    @staticmethod
    async def update_policies(db: AsyncSession, obj: UpdatePoliciesParam, user_id: int) -> None:
        for item in obj.items:
            kind = _require_kind(item.kind)
            channel = NotificationChannel(item.channel)
            if channel not in kind.defaults:
                raise errors.RequestError(
                    msg=t('error.notification.channel_not_supported', kind=kind.code, channel=channel.value)
                )
            if channel is NotificationChannel.inapp:
                raise errors.RequestError(msg=t('error.notification.inapp_fixed'))
            mode = PolicyMode(item.mode)
            if mode is kind.defaults[channel]:
                # 改回默认值 = 删掉那一格：注册表的默认值以后变了，这一格会跟着变，而不是被一行旧覆盖钉住
                await notification_policy_dao.delete_cell(db, kind=kind.code, channel=channel.value)
            else:
                await notification_policy_dao.upsert(
                    db, kind=kind.code, channel=channel.value, mode=mode.value, user_id=user_id
                )

    @staticmethod
    async def get_my_prefs(db: AsyncSession, user_id: int) -> dict[str, Any]:
        overrides: dict[str, dict[str, str]] = {}
        for p in await notification_policy_dao.get_all(db):
            overrides.setdefault(p.kind, {})[p.channel] = p.mode
        prefs = {(p.kind, p.channel): p.enabled for p in await notification_pref_dao.get_for_users(db, [user_id])}
        user = (await db.execute(select(User.email, User.phone).where(User.id == user_id))).first()
        rows = []
        for kind in _kinds():
            if not kind.user_configurable:
                continue
            modes = effective_modes(kind, overrides.get(kind.code, {}))
            cells = []
            for ch in kind.channels:
                mode = modes[ch]
                configurable = ch is not NotificationChannel.inapp and mode in (
                    PolicyMode.default_on,
                    PolicyMode.default_off,
                )
                cells.append({
                    'channel': ch.value,
                    'mode': mode.value,
                    'configurable': configurable,
                    'enabled': wants(mode, pref=prefs.get((kind.code, ch.value)), configurable=True),
                })
            rows.append({'kind': kind.code, 'label': kind.label, 'category': kind.category.value, 'cells': cells})
        return {
            'items': rows,
            # 没邮箱 / 没手机号时界面上那一列提示「先去绑定」—— 开着也收不到，记成 skipped
            'has_email': bool(user and user.email),
            'has_phone': bool(user and user.phone),
        }

    @staticmethod
    async def update_my_prefs(db: AsyncSession, obj: UpdatePrefsParam, user_id: int) -> None:
        overrides: dict[str, dict[str, str]] = {}
        for p in await notification_policy_dao.get_all(db, [i.kind for i in obj.items]):
            overrides.setdefault(p.kind, {})[p.channel] = p.mode
        for item in obj.items:
            kind = _require_kind(item.kind)
            channel = NotificationChannel(item.channel)
            modes = effective_modes(kind, overrides.get(kind.code, {}))
            mode = modes.get(channel)
            # 🔴 forced / off 的格子、站内、不让人自己设的类型都拒绝：存下来不起作用，界面上却显示「已关闭」，
            # 等管理员把策略改回 default_on 时它又突然生效 —— 两个意外
            if (
                not kind.user_configurable
                or mode is None
                or channel is NotificationChannel.inapp
                or mode not in (PolicyMode.default_on, PolicyMode.default_off)
            ):
                raise errors.RequestError(
                    msg=t('error.notification.pref_not_configurable', kind=kind.code, channel=channel.value)
                )
            await notification_pref_dao.upsert(
                db, user_id=user_id, kind=kind.code, channel=channel.value, enabled=item.enabled
            )


channel_service: ChannelService = ChannelService()
