"""对使用方的唯一入口：`await sms_service.send(phone, template, params)`（issue #153 第三节）。

步骤：校验号码和参数 → 选配置（第二节第 4 条）→ 频率防护占位 → **插入「发送中」日志并提交** →
调 SDK → 更新日志 → 按结果释放或保留冷却位 → 返回或抛 `SmsSendError`。

🔴 **`send()` 不参与调用方的事务**：读写全部用独立会话（`async with async_db_session.begin()`，同
`login_log_service.create`）。调用方要在自己的写操作**提交之后**再发，否则会出现「短信发了、业务回滚了」。
初稿写的是「在请求会话里用 `begin_nested()` 包住日志，再抛 502」—— **实测失败日志会丢**（一次性 PostgreSQL 库）：
`begin_nested` 只防「日志写失败弄坏外层事务」，挡不住「外层回滚把日志一起带走」。

⚠️ 这是「模块顶层 import 了 `async_db_session`」的代码，登记在 `backend/conftest.py` 的
`_PATCHED_SESSION_MODULES` 里，否则跑测试往开发库写日志。
"""

from __future__ import annotations

import json
import random
import re
import uuid

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from backend.common.log import log
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.plugin.sms.crud.crud_config import sms_config_dao
from backend.plugin.sms.crud.crud_log import sms_log_dao
from backend.plugin.sms.enums import CIRCUIT_OPEN, SmsGuardVerdict, SmsLogStatus
from backend.plugin.sms.errors import SmsSendError
from backend.plugin.sms.extensions import load_sms_extensions
from backend.plugin.sms.model import SmsConfig, SmsLog
from backend.plugin.sms.schema.config import SmsSendResultSchema
from backend.plugin.sms.schema.log import mask_phone
from backend.plugin.sms.sdk.base import (
    UNSENT_KINDS,
    SmsErrorKind,
    SmsMessage,
    SmsResult,
    SmsStatus,
    TemplateMapping,
    render_template_params,
)
from backend.plugin.sms.service.config_service import parse_templates, provider_or_raise, sms_config_service
from backend.plugin.sms.service.guard import sms_guard
from backend.plugin.sms.templates import SmsTemplate, get_sms_template
from backend.utils.snowflake import snowflake

#: 厂商侧参数：按变量名的厂商是 dict，按位置的是 list
ProviderParams = Mapping[str, str] | Sequence[str]

# 第一期只收大陆号（和 `common/schema.py: CustomPhoneNumber` 同一条正则）
_PHONE_RE = re.compile(r'^1[3-9]\d{9}$')
#: 测试短信在日志里的业务模板码
TEST_TEMPLATE_CODE = 'test'
_MASK = '***'


def _t(key: str, **kwargs: Any) -> str:
    # 延迟 import：i18n 要读请求上下文，放模块顶层会让纯函数测试也拖进 starlette-context
    from backend.common.i18n import t

    return t(key, **kwargs)


def _log_status(result: SmsResult) -> SmsLogStatus:
    if result.status is SmsStatus.accepted:
        return SmsLogStatus.accepted
    if result.status is SmsStatus.unknown:
        return SmsLogStatus.unknown
    return SmsLogStatus.failed


def _to_schema(result: SmsResult, log_id: int | None) -> SmsSendResultSchema:
    return SmsSendResultSchema(
        status=result.status.value,
        error_kind=result.error_kind.value if result.error_kind else None,
        provider_code=result.provider_code,
        provider_msg=result.provider_msg,
        request_id=result.request_id,
        biz_id=result.biz_id,
        duration_ms=result.duration_ms,
        log_id=str(log_id) if log_id is not None else None,
    )


def mask_params(
    kind: TemplateMapping,
    mapping: Mapping[str, str] | Sequence[str],
    rendered: Mapping[str, str] | Sequence[str],
    sensitive: frozenset[str],
) -> dict[str, str] | list[str]:
    """落日志用：把声明为敏感的业务参数对应的厂商侧值打码"""
    if kind is TemplateMapping.named:
        assert isinstance(mapping, Mapping) and isinstance(rendered, Mapping)
        return {var: (_MASK if mapping[var] in sensitive else value) for var, value in rendered.items()}
    return [(_MASK if param in sensitive else value) for param, value in zip(mapping, rendered, strict=True)]


def pick_config(candidates: Sequence[SmsConfig], *, rng: random.Random | None = None) -> SmsConfig | None:
    """选配置的纯规则（不碰 Redis，给单测用）：默认配置在候选里 → 用它；否则按 `weight` 加权随机（0 不参与）"""
    for c in candidates:
        if c.is_default:
            return c
    weighted = [c for c in candidates if c.weight > 0]
    if not weighted:
        return None
    return (rng or random).choices(weighted, weights=[c.weight for c in weighted], k=1)[0]


class SmsService:
    """发送"""

    @staticmethod
    def _validate(phone: str, template_code: str, params: Mapping[str, Any]) -> SmsTemplate:
        # 🔴 注册表不能只靠路由装配时装（`api/router.py`）：Celery worker 不 import 任何路由，定时任务里
        # 调 `send()` 会报「业务模板未注册」/「厂商不存在」。这里再装一次是幂等的（一个布尔判断）
        load_sms_extensions()
        template = get_sms_template(template_code)
        if template is None:
            raise SmsSendError(
                kind=SmsErrorKind.bad_params.value, msg=_t('error.sms.template_unknown', template=template_code)
            )
        if not _PHONE_RE.match(phone or ''):
            raise SmsSendError(kind=SmsErrorKind.invalid_phone.value, msg=_t('error.sms.invalid_phone'))
        expected, received = set(template.params), set(params)
        if expected != received:
            raise SmsSendError(
                kind=SmsErrorKind.bad_params.value,
                msg=_t(
                    'error.sms.params_mismatch',
                    template=template_code,
                    expected=', '.join(template.params),
                    received=', '.join(sorted(received)) or '（空）',
                ),
            )
        return template

    @staticmethod
    async def _choose(template_code: str, config_id: int | None) -> tuple[SmsConfig, str]:
        """第二节第 4 条。每次**现查**，不缓存。返回 (配置, 占到的日计数键) —— 键交给 `_dispatch_counted` 退还"""
        async with async_db_session() as db:
            if config_id is not None:
                config = await sms_config_dao.get(db, config_id)
                if config is None:
                    raise SmsSendError(kind=SmsErrorKind.config_error.value, msg=_t('error.sms.config_not_found'))
                if config.status != 1:
                    raise SmsSendError(kind=SmsErrorKind.config_error.value, msg=_t('error.sms.config_disabled'))
                if template_code not in parse_templates(config):
                    raise SmsSendError(
                        kind=SmsErrorKind.config_error.value,
                        msg=_t('error.sms.template_not_configured', name=config.name, template=template_code),
                    )
                # 指定了就只用它：日上限照样计数，但不拦（指定是调用方的明确意图；daily_max=0 永远占得到）
                slot = await sms_guard.reserve_config(config.id, 0)
                assert slot is not None
                return config, slot
            configs = list(await sms_config_dao.get_enabled(db))

        candidates = [c for c in configs if template_code in parse_templates(c)]
        while candidates:
            chosen = pick_config(candidates)
            if chosen is None:
                break
            slot = await sms_guard.reserve_config(chosen.id, chosen.daily_max)
            if slot is not None:
                return chosen, slot
            # 到了日上限：退出自动选取，换下一个候选
            candidates = [c for c in candidates if c.id != chosen.id]
        # 一个候选都没有 → 明确报错，**不静默跳过**
        raise SmsSendError(kind=SmsErrorKind.config_error.value, msg=_t('error.sms.no_config', template=template_code))

    @classmethod
    async def _dispatch_counted(
        cls,
        *,
        config: SmsConfig,
        slot: str,
        phone: str,
        template_code: str,
        user_id: int | None,
        build: Callable[[], tuple[str, ProviderParams, ProviderParams]],
    ) -> tuple[SmsResult, int]:
        """占了配置名额之后的发送。**退名额的规则只在这里一处**（业务发送和测试短信共用）：

        - `build()`（渲染参数）或 `_dispatch`（落日志 / 调 SDK）抛异常 → 还没发出去，退
        - 结果是 `UNSENT_KINDS`（配置错 / 参数错 / 号码错 / 鉴权错 / 没连上）→ 厂商一条没收，退。
          填错模板 ID 反复试的那种每次都是 `config_error`，不该把「今日已发」刷上去
        - 「结果未知」（读超时）不退：可能已经发出去了
        """
        try:
            template_id, provider_params, logged_params = build()
            result, log_id = await cls._dispatch(
                config=config,
                phone=phone,
                template_code=template_code,
                template_id=template_id,
                provider_params=provider_params,
                logged_params=logged_params,
                user_id=user_id,
            )
        except Exception:
            await sms_guard.release_config(slot)
            raise
        if result.error_kind in UNSENT_KINDS:
            await sms_guard.release_config(slot)
        return result, log_id

    @staticmethod
    async def _dispatch(
        *,
        config: SmsConfig,
        phone: str,
        template_code: str,
        template_id: str,
        provider_params: Mapping[str, str] | Sequence[str],
        logged_params: Mapping[str, str] | Sequence[str],
        user_id: int | None,
    ) -> tuple[SmsResult, int]:
        """两段式日志 + 调 SDK。返回 (结果, 日志 id)"""
        provider = sms_config_service.build_provider(config)
        log_id = snowflake.generate()
        row = SmsLog(
            provider=config.provider,
            phone=phone,
            template=template_code,
            status=SmsLogStatus.sending.value,
            config_id=config.id,
            template_id=template_id,
            params=json.dumps(logged_params, ensure_ascii=False),
            created_by=user_id,
        )
        row.id = log_id
        # 1. 发送前插入一行「发送中」，提交。插入失败就不发（不允许没有审计记录的发送）—— 异常直接冒出去
        async with async_db_session.begin() as db:
            db.add(row)

        result = await provider.send(
            SmsMessage(
                phone=phone,
                template_id=template_id,
                params=provider_params,
                sign_name=config.sign_name,
                out_id=str(log_id),
            )
        )

        # 2. 发完更新为最终状态。更新失败只记 log.error，不影响返回给调用方的结果
        try:
            async with async_db_session.begin() as db:
                await sms_log_dao.settle(
                    db,
                    log_id,
                    status=_log_status(result).value,
                    error_kind=result.error_kind.value if result.error_kind else None,
                    provider_code=result.provider_code,
                    provider_msg=result.provider_msg,
                    request_id=result.request_id,
                    biz_id=result.biz_id,
                    duration_ms=result.duration_ms,
                )
        except Exception as e:
            log.error(f'短信日志 {log_id} 更新终态失败（结果 {result.status.value} / {result.error_kind}）：{e!s}')

        if result.error_kind in (SmsErrorKind.config_error, SmsErrorKind.account_error):
            # 这两类不是用户的问题，是配置 / 账号的问题 —— 要报警
            log.error(
                f'短信配置「{config.name}」({config.provider}) 发送失败 [{result.error_kind.value}] '
                f'{result.provider_code}: {result.provider_msg}（日志 {log_id}）'
            )
        return result, log_id

    @classmethod
    async def send(
        cls,
        *,
        phone: str,
        template: str,
        params: Mapping[str, Any],
        config_id: int | None = None,
        user_id: int | None = None,
    ) -> SmsSendResultSchema:
        """发一条业务短信。

        :param phone: 大陆 11 位手机号
        :param template: 业务模板码（`register_sms_template` 注册过的）
        :param params: 业务参数，键必须和模板声明的 `params` 完全一致
        :param config_id: 指定用哪条配置（必须是启用的）；不给就按默认 / 权重 / 日上限自动选
        :param user_id: 发起人（匿名接口为 None），落日志用
        :raises SmsSendError: 失败一律抛，带 `kind`；`invalid_phone` / `rate_limited` 是 400，其余 502
        """
        tpl = cls._validate(phone, template, params)

        token = uuid.uuid4().hex
        verdict = await sms_guard.acquire(tpl, phone, token)
        if verdict in (SmsGuardVerdict.cooldown, SmsGuardVerdict.phone_daily):
            # 被我们自己拦下的**不写 sms_log**（否则刷接口就是刷日志表），只写应用日志
            log.info(f'短信被拦（{verdict.value}）：模板 {template} 号码 {mask_phone(phone)}')
            raise SmsSendError(kind=SmsErrorKind.rate_limited.value, msg=_t('error.sms.too_frequent'))
        if verdict is SmsGuardVerdict.circuit:
            log.error(f'短信全站熔断：本小时已达 {settings.SMS_GLOBAL_HOURLY_MAX} 条上限，拒绝发送（模板 {template}）')
            raise SmsSendError(kind=CIRCUIT_OPEN, msg=_t('error.sms.circuit_open'))

        try:
            config, slot = await cls._choose(template, config_id)

            def build() -> tuple[str, ProviderParams, ProviderParams]:
                provider_cls = provider_or_raise(config.provider)
                spec = parse_templates(config)[template]
                rendered = render_template_params(
                    provider_cls.template_mapping, spec['mapping'], {k: str(v) for k, v in params.items()}
                )
                logged = mask_params(provider_cls.template_mapping, spec['mapping'], rendered, tpl.sensitive)
                return spec['template_id'], rendered, logged

            result, log_id = await cls._dispatch_counted(
                config=config, slot=slot, phone=phone, template_code=template, user_id=user_id, build=build
            )
        except Exception:
            # 还没发出去（没有可用配置 / 指定的配置不对 / 落日志那一步炸了）：冷却位还回去；
            # 配置的名额由 `_dispatch_counted` 自己退
            await sms_guard.release_cooldown(tpl, phone, token)
            raise

        if result.error_kind in UNSENT_KINDS:
            # 厂商一条都没收到：冷却位也还回去（配置的日计数已在 `_dispatch_counted` 里退了）
            await sms_guard.release_cooldown(tpl, phone, token)
        if result.ok:
            return _to_schema(result, log_id)
        kind = (result.error_kind or SmsErrorKind.unknown).value
        raise SmsSendError(kind=kind, msg=_t(f'error.sms.send_failed.{kind}'), result=result, log_id=log_id)

    @classmethod
    async def send_test(
        cls,
        *,
        config: SmsConfig,
        phone: str,
        template_id: str,
        params: Mapping[str, str] | Sequence[str],
        user_id: int | None,
    ) -> SmsSendResultSchema:
        """配置页「发测试短信」：绕过业务模板和频率防护（接口上另有按操作人的 RateLimiter）。

        参数**不打码**：人填的就是要看的。
        """
        if not _PHONE_RE.match(phone or ''):
            raise SmsSendError(kind=SmsErrorKind.invalid_phone.value, msg=_t('error.sms.invalid_phone'))
        provider_params: dict[str, str] | list[str] = (
            {str(k): str(v) for k, v in params.items()} if isinstance(params, Mapping) else [str(v) for v in params]
        )
        # 测试短信不走 acquire（人点一次发一次，接口限流兜着），也不进全站熔断的计数；
        # 但配置的日计数要加，否则「今日已发」对不上账（daily_max=0 永远占得到）
        slot = await sms_guard.reserve_config(config.id, 0)
        assert slot is not None
        result, log_id = await cls._dispatch_counted(
            config=config,
            slot=slot,
            phone=phone,
            template_code=TEST_TEMPLATE_CODE,
            user_id=user_id,
            build=lambda: (template_id, provider_params, provider_params),
        )
        return _to_schema(result, log_id)


sms_service: SmsService = SmsService()
