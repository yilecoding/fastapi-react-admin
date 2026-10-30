"""群机器人（#166 二期）：配置的增删改查 · 发测试消息 · 有通知时给订阅它的机器人写投递行。

- 🔴 **Webhook 地址和加签密钥都加密存**（`NOTIFICATION_ENCRYPT_SECRET_KEY`），
  没配密钥就拒绝保存，不静默存明文
- 🔴 **地址只许落在三家官方的前缀上**（+ `NOTIFICATION_BOT_EXTRA_URL_PREFIXES`）。服务端会往这个地址发请求，
  随便填等于让有这个权限的人借服务器去扫内网 —— 比 Webhook 端点（#167）的「解析后查 IP」更严，
  因为这里的目标本来就只有三家
- 投递是**一条通知 × 一个机器人一行**，不按收件人展开：同一条「审批结果」发给 3 个人，群里只该出现一次
"""

from __future__ import annotations

import json

from typing import TYPE_CHECKING, Any

from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.plugin.notification.bot_platforms import SIGNING, has_credential, mask_url, url_allowed
from backend.plugin.notification.crud.crud_bot import notification_bot_dao
from backend.plugin.notification.enums import BotPlatform, DeliveryStatus, NotificationChannel
from backend.plugin.notification.extensions import load_notification_extensions
from backend.plugin.notification.kinds import get_notification_kind, list_notification_kinds
from backend.plugin.notification.model import NotificationBot, NotificationDelivery
from backend.utils.encrypt import AESCipher

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.plugin.notification.kinds import NotificationKind
    from backend.plugin.notification.schema.bot import BotTestResult, CreateBotParam, UpdateBotParam


# ── 加解密 ───────────────────────────────────────────────────────────────────


def _cipher() -> AESCipher:
    """🔴 没配密钥就拒绝，不静默存明文（同短信 / 能力开放 / AI 供应商）"""
    key = settings.NOTIFICATION_ENCRYPT_SECRET_KEY
    if not key:
        raise errors.ServerError(msg=t('error.notification.encrypt_key_unset'))
    try:
        return AESCipher(key)
    except ValueError as e:
        raise errors.ServerError(msg=t('error.notification.encrypt_key_invalid')) from e


def encrypt(plain: str) -> str:
    return _cipher().encrypt(plain).hex()


def decrypt(cipher_hex: str) -> str:
    return _cipher().decrypt(bytes.fromhex(cipher_hex))


def encrypt_key_ready() -> bool:
    try:
        _cipher()
    except errors.ServerError:
        return False
    return True


# ── 校验 ─────────────────────────────────────────────────────────────────────


def extra_url_prefixes() -> tuple[str, ...]:
    raw = str(settings.NOTIFICATION_BOT_EXTRA_URL_PREFIXES or '')
    return tuple(p.strip() for p in raw.split(',') if p.strip())


def _check_url(platform: str, url: str) -> str:
    url = url.strip()
    if not url_allowed(platform, url, extra_url_prefixes()):
        raise errors.RequestError(msg=t(f'error.notification.bot_url_{platform}'))
    if not has_credential(platform, url):
        raise errors.RequestError(msg=t('error.notification.bot_url_no_token'))
    return url


def bot_kinds() -> list[NotificationKind]:
    """能被机器人订阅的类型：声明了 `bot=True` 的"""
    load_notification_extensions()
    return [k for k in list_notification_kinds() if k.bot]


def _check_kinds(kinds: list[str]) -> list[str]:
    load_notification_extensions()
    for code in kinds:
        kind = get_notification_kind(code)
        if kind is None:
            raise errors.RequestError(msg=t('error.notification.kind_not_found', kind=code))
        if not kind.bot:
            # 对着收件人说话的类型（「抄送给你」）推到群里，群里每个人读到的都是「你」
            raise errors.RequestError(msg=t('error.notification.bot_kind_not_allowed', kind=kind.label))
    return kinds


def _check_secret(platform: str, secret: str | None) -> str | None:
    secret = (secret or '').strip() or None
    if secret and platform not in SIGNING:
        # 企微没有签名：收下一个密钥、界面上显示「已开加签」，实际上什么都不做
        raise errors.RequestError(msg=t('error.notification.bot_secret_unsupported'))
    return secret


def subscribed_kinds(bot: NotificationBot) -> list[str]:
    try:
        value = json.loads(bot.kinds or '[]')
    except ValueError:
        return []
    return [k for k in value if isinstance(k, str)] if isinstance(value, list) else []


def to_detail(bot: NotificationBot) -> dict[str, Any]:
    return {
        'id': bot.id,
        'name': bot.name,
        'platform': bot.platform,
        'kinds': subscribed_kinds(bot),
        'status': bot.status,
        'remark': bot.remark,
        'webhook_hint': bot.webhook_hint,
        'has_secret': bool(bot.secret_cipher),
        'last_sent_time': bot.last_sent_time,
        'last_error': bot.last_error,
        'created_time': bot.created_time,
        'updated_time': bot.updated_time,
    }


# ── 投递 ─────────────────────────────────────────────────────────────────────


async def enqueue_bots(db: AsyncSession, *, kind: NotificationKind, title: str, content: str, link: str | None) -> int:
    """在调用方的事务里给订阅了这个类型的机器人各写一行投递，返回行数（> 0 时提交后要踢 worker）。不 commit、不 flush"""
    if not kind.bot:
        return 0
    n = 0
    for bot in await notification_bot_dao.get_enabled(db):
        if kind.code not in subscribed_kinds(bot):
            continue
        db.add(
            NotificationDelivery(
                notification_id=None,
                user_id=None,
                bot_id=bot.id,
                kind=kind.code,
                channel=NotificationChannel.bot.value,
                # 机器人名称的快照：机器人删了，投递记录里还读得出当时发去了哪个群
                address=bot.name,
                title=title[:128],
                content=content,
                link=link,
                status=DeliveryStatus.pending.value,
            )
        )
        n += 1
    return n


# ── 管理端 ───────────────────────────────────────────────────────────────────


class BotService:
    @staticmethod
    def options() -> dict[str, Any]:
        return {
            'kinds': [{'kind': k.code, 'label': k.label, 'category': k.category.value} for k in bot_kinds()],
            'encrypt_key_ready': encrypt_key_ready(),
        }

    @staticmethod
    async def get_list(db: AsyncSession) -> list[dict[str, Any]]:
        return [to_detail(b) for b in await notification_bot_dao.get_all(db)]

    @staticmethod
    async def get(db: AsyncSession, pk: int) -> NotificationBot:
        bot = await notification_bot_dao.get(db, pk)
        if bot is None:
            raise errors.NotFoundError(msg=t('error.notification.bot_not_found'))
        return bot

    @staticmethod
    async def create(db: AsyncSession, obj: CreateBotParam, user_id: int) -> dict[str, Any]:
        platform = BotPlatform(obj.platform).value
        url = _check_url(platform, obj.webhook_url)
        secret = _check_secret(platform, obj.sign_secret)
        kinds = _check_kinds(obj.kinds)
        bot = NotificationBot(
            name=obj.name,
            platform=platform,
            webhook_cipher=encrypt(url),
            webhook_hint=mask_url(url),
            kinds=json.dumps(kinds),
            secret_cipher=encrypt(secret) if secret else None,
            status=obj.status,
            remark=obj.remark,
            created_by=user_id,
        )
        db.add(bot)
        await db.flush()
        return to_detail(bot)

    @staticmethod
    async def update(db: AsyncSession, pk: int, obj: UpdateBotParam) -> dict[str, Any]:
        bot = await BotService.get(db, pk)
        platform = BotPlatform(obj.platform).value
        if platform != bot.platform and not (obj.webhook_url or '').strip():
            # 🔴 换了平台就必须给新地址：旧地址是上一家的，留着就是「平台是钉钉、地址是飞书的」，
            # 每次都失败（同短信换厂商）
            raise errors.RequestError(msg=t('error.notification.bot_url_required_on_platform_change'))
        if (obj.webhook_url or '').strip():
            url = _check_url(platform, obj.webhook_url or '')
            bot.webhook_cipher = encrypt(url)
            bot.webhook_hint = mask_url(url)
        secret = _check_secret(platform, obj.sign_secret)
        # 🔴 换了平台，旧密钥是上一家发的：钉钉的密钥签飞书的消息，每条都 19021、按永久失败不重试
        if obj.clear_sign_secret or platform not in SIGNING or (platform != bot.platform and not secret):
            bot.secret_cipher = None
        elif secret:
            bot.secret_cipher = encrypt(secret)
        bot.kinds = json.dumps(_check_kinds(obj.kinds))
        bot.name = obj.name
        bot.platform = platform
        bot.status = obj.status
        bot.remark = obj.remark
        if obj.status == 1:
            # 重新启用 / 改了配置：上一次的失败原因已经不代表现在
            bot.last_error = None
        await db.flush()
        return to_detail(bot)

    @staticmethod
    async def delete(db: AsyncSession, pk: int) -> None:
        bot = await BotService.get(db, pk)
        await db.delete(bot)

    @staticmethod
    async def send_test(db: AsyncSession, pk: int) -> BotTestResult:
        """直接发一条，不经过投递表：人在配置页上等着看结果。停用的也能测（测通了再启用）"""
        from backend.plugin.notification.schema.bot import BotTestResult
        from backend.plugin.notification.service.senders import Outcome, post_bot

        bot = await BotService.get(db, pk)
        try:
            url = decrypt(bot.webhook_cipher)
            secret = decrypt(bot.secret_cipher) if bot.secret_cipher else None
        except Exception as e:
            # 轮换了 NOTIFICATION_ENCRYPT_SECRET_KEY 之后旧密文解不开：
            # 和 worker 一样报 config_error，不是一个看不出原因的 500
            error = repr(e)[:2000]
            await notification_bot_dao.record_result(db, bot.id, ok=False, error=error)
            return BotTestResult(ok=False, reason='config_error', error=error)
        result = await post_bot(
            bot.platform,
            url,
            secret,
            title=t('notification.bot.test_title'),
            content=t('notification.bot.test_content', name=bot.name),
            link=None,
        )
        ok = result.outcome is Outcome.sent
        await notification_bot_dao.record_result(db, bot.id, ok=ok, error=result.error)
        return BotTestResult(ok=ok, reason=result.reason, error=result.error, duration_ms=result.duration_ms)


bot_service: BotService = BotService()
