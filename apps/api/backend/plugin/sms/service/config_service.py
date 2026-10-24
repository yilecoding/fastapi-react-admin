"""短信配置（issue #153 第二节）：保存时把写错的东西拦在门外。

写错的键名、模板码、参数名一律 400 —— 否则要到发送时才失败，看起来像通道坏了
（MCP 凭据那轮踩过：白名单写错能存，表现是对方永远 403）。
"""

from __future__ import annotations

import json

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ValidationError

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.plugin.sms.crud.crud_config import sms_config_dao
from backend.plugin.sms.model import SmsConfig
from backend.plugin.sms.model.log import TEMPLATE_ID_MAX_LEN
from backend.plugin.sms.sdk.base import SmsProvider, TemplateMapping, validate_template_mapping
from backend.plugin.sms.sdk.registry import get_provider, list_providers, provider_descriptor
from backend.plugin.sms.service.guard import sms_guard
from backend.plugin.sms.templates import get_sms_template, list_sms_templates
from backend.utils.encrypt import AESCipher

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.plugin.sms.schema.config import (
        CreateSmsConfigParam,
        SmsSendResultSchema,
        TestSmsParam,
        UpdateSmsConfigParam,
    )


def _cipher() -> AESCipher:
    """🔴 没配密钥就拒绝保存，不静默存明文（同 AI 供应商 / 能力开放 / 存储）"""
    key = settings.SMS_ENCRYPT_SECRET_KEY
    if not key:
        raise errors.ServerError(msg=t('error.sms.encrypt_key_unset'))
    try:
        return AESCipher(key)
    except ValueError as e:
        raise errors.ServerError(msg=t('error.sms.encrypt_key_invalid')) from e


def mask_secret(secret: str) -> str:
    """短密钥全掩 —— 8 位以内露首尾等于露出大半个"""
    if len(secret) <= 8:
        return '*' * len(secret)
    return f'{secret[:4]}{"*" * 6}{secret[-4:]}'


def provider_or_raise(code: str) -> type[SmsProvider]:
    cls = get_provider(code)
    if cls is None:
        raise errors.RequestError(msg=t('error.sms.provider_unknown', provider=code))
    return cls


def build_provider_config(
    provider_cls: type[SmsProvider], *, access_key_id: str | None, secret: str | None, options: Mapping[str, Any]
) -> BaseModel:
    """把「表里的三列」拼成这家厂商的 `Config`，顺带把写错的键名、缺的凭据都拦下来"""
    data: dict[str, Any] = dict(options)
    fields = set(provider_cls.Config.model_fields)
    creds = provider_cls.credential_fields
    if creds is not None:
        key_field, secret_field = creds
        # 凭据不能从 options 里绕进来：那样会明文落库
        for f in (key_field, secret_field):
            data.pop(f, None)
        if not access_key_id or not secret:
            raise errors.RequestError(msg=t('error.sms.credential_required', fields=f'{key_field} / {secret_field}'))
        data[key_field] = access_key_id
        data[secret_field] = secret
    unknown = sorted(set(data) - fields)
    if unknown:
        raise errors.RequestError(
            msg=t(
                'error.sms.config_invalid',
                detail=f'未知的配置项 {", ".join(unknown)}（可用：{", ".join(sorted(fields - set(creds or ())))}）',
            )
        )
    try:
        return provider_cls.Config(**data)
    except ValidationError as e:
        first = e.errors()[0]
        loc = '.'.join(str(p) for p in first.get('loc', ()))
        raise errors.RequestError(msg=t('error.sms.config_invalid', detail=f'{loc}: {first.get("msg")}')) from e


def validate_templates(provider_cls: type[SmsProvider], templates: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """`{业务模板码: {template_id, mapping}}`：模板码已注册、引用的业务参数都是该模板声明过的"""
    result: dict[str, dict[str, Any]] = {}
    for code, spec in templates.items():
        template = get_sms_template(code)
        if template is None:
            raise errors.RequestError(msg=t('error.sms.template_unknown', template=code))
        if not isinstance(spec, Mapping):
            raise errors.RequestError(msg=t('error.sms.template_shape', template=code))
        template_id = str(spec.get('template_id') or '').strip()
        if not template_id:
            raise errors.RequestError(msg=t('error.sms.template_shape', template=code))
        if len(template_id) > TEMPLATE_ID_MAX_LEN:
            # 和 `sms_log.template_id` 的列宽一致；超了不拦在这里，就是发送时插日志那一步 DataError 500
            raise errors.RequestError(msg=t('error.sms.template_id_too_long', template=code, max=TEMPLATE_ID_MAX_LEN))
        try:
            mapping = validate_template_mapping(provider_cls.template_mapping, spec.get('mapping'), template.params)
        except ValueError as e:
            raise errors.RequestError(msg=t('error.sms.template_mapping_invalid', template=code, detail=str(e))) from e
        result[code] = {'template_id': template_id, 'mapping': mapping}
    return result


def parse_templates(config: SmsConfig) -> dict[str, dict[str, Any]]:
    return json.loads(config.templates or '{}')


def parse_options(config: SmsConfig) -> dict[str, Any]:
    return json.loads(config.options or '{}')


class SmsConfigService:
    """短信配置管理"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> SmsConfig:
        config = await sms_config_dao.get(db, pk)
        if not config:
            raise errors.NotFoundError(msg=t('error.sms.config_not_found'))
        return config

    @classmethod
    async def get_detail(cls, *, db: AsyncSession, pk: int) -> dict[str, Any]:
        """详情接口用：和列表同一个形状（带 `today_sent`）；密文列**不进** dict"""
        config = await cls.get(db=db, pk=pk)
        detail = {c.name: getattr(config, c.name) for c in SmsConfig.__table__.columns if c.name != 'secret_cipher'}
        detail['today_sent'] = (await sms_guard.today_sent([config.id])).get(config.id, 0)
        return detail

    @staticmethod
    async def get_list(
        *, db: AsyncSession, name: str | None, provider: str | None, status: int | None
    ) -> dict[str, Any]:
        select = await sms_config_dao.get_select(name=name, provider=provider, status=status)
        page = await paging_data(db, select)
        counts = await sms_guard.today_sent([int(item['id']) for item in page['items']])
        for item in page['items']:
            item['today_sent'] = counts.get(int(item['id']), 0)
        return page

    @staticmethod
    def providers() -> list[dict[str, Any]]:
        return [provider_descriptor(cls) for cls in list_providers()]

    @staticmethod
    def templates() -> list[dict[str, Any]]:
        return [
            {
                'code': tpl.code,
                'label': tpl.label,
                'params': list(tpl.params),
                'sensitive': sorted(tpl.sensitive),
                'cooldown_seconds': tpl.cooldown_seconds,
                'daily_max_per_phone': tpl.daily_max_per_phone,
            }
            for tpl in list_sms_templates()
        ]

    @staticmethod
    def _validate(
        obj: CreateSmsConfigParam | UpdateSmsConfigParam, *, secret: str | None
    ) -> tuple[type[SmsProvider], dict[str, Any]]:
        """保存前的全部校验，返回 (厂商类, 归一化后的 templates)"""
        provider_cls = provider_or_raise(obj.provider)
        build_provider_config(provider_cls, access_key_id=obj.access_key_id, secret=secret, options=obj.options)
        templates = validate_templates(provider_cls, obj.templates)
        if obj.is_default and obj.status != 1:
            raise errors.RequestError(msg=t('error.sms.default_disabled'))
        return provider_cls, templates

    @classmethod
    async def create(cls, *, db: AsyncSession, obj: CreateSmsConfigParam, user_id: int) -> SmsConfig:
        if await sms_config_dao.get_by_name(db, obj.name):
            raise errors.ConflictError(msg=t('error.sms.name_exists'))
        provider_cls, templates = cls._validate(obj, secret=obj.access_key_secret)

        has_creds = provider_cls.credential_fields is not None
        secret_cipher = secret_mask = access_key_id = None
        if has_creds:
            cipher = _cipher()
            access_key_id = obj.access_key_id
            secret_cipher = cipher.encrypt(obj.access_key_secret or '').hex()
            secret_mask = mask_secret(obj.access_key_secret or '')

        data = obj.model_dump(exclude={'access_key_secret', 'access_key_id', 'options', 'templates'})
        config = SmsConfig(
            **data,
            access_key_id=access_key_id,
            secret_cipher=secret_cipher,
            secret_mask=secret_mask,
            options=json.dumps(obj.options, ensure_ascii=False),
            templates=json.dumps(templates, ensure_ascii=False),
            created_by=user_id,
        )
        db.add(config)
        await db.flush()
        if obj.is_default:
            # 同一事务里清掉其它行的默认标记（照 ContiNew `setDefaultConfig`）
            await sms_config_dao.clear_default(db, exclude_pk=config.id)
        return config

    @classmethod
    async def update(cls, *, db: AsyncSession, pk: int, obj: UpdateSmsConfigParam) -> None:
        config = await cls.get(db=db, pk=pk)
        existing = await sms_config_dao.get_by_name(db, obj.name)
        if existing and existing.id != pk:
            raise errors.ConflictError(msg=t('error.sms.name_exists'))

        # 留空 = 不动密钥；校验用解密后的旧值（发送时用的也是它）。
        # 🔴 换了厂商就必须给新密钥：旧密钥是上一家的，形状校验照样能过，存下来的是「厂商是腾讯云、密钥是阿里云的」
        # 这种每次发送都鉴权失败、界面上又看不出来的配置
        secret = obj.access_key_secret or None
        provider_cls = provider_or_raise(obj.provider)
        if not secret and obj.provider != config.provider and provider_cls.credential_fields is not None:
            raise errors.RequestError(
                msg=t('error.sms.credential_required', fields=' / '.join(provider_cls.credential_fields))
            )
        if not secret and config.secret_cipher:
            secret = _cipher().decrypt(config.secret_cipher)
        provider_cls, templates = cls._validate(obj, secret=secret)

        data = obj.model_dump(exclude={'access_key_secret', 'access_key_id', 'options', 'templates'})
        data['options'] = json.dumps(obj.options, ensure_ascii=False)
        data['templates'] = json.dumps(templates, ensure_ascii=False)
        if provider_cls.credential_fields is None:
            data['access_key_id'] = None
            data['secret_cipher'] = None
            data['secret_mask'] = None
        else:
            data['access_key_id'] = obj.access_key_id
            if obj.access_key_secret:
                cipher = _cipher()
                data['secret_cipher'] = cipher.encrypt(obj.access_key_secret).hex()
                data['secret_mask'] = mask_secret(obj.access_key_secret)
        for field, value in data.items():
            setattr(config, field, value)
        await db.flush()
        if obj.is_default:
            await sms_config_dao.clear_default(db, exclude_pk=pk)

    @classmethod
    async def set_default(cls, *, db: AsyncSession, pk: int) -> None:
        config = await cls.get(db=db, pk=pk)
        if config.status != 1:
            raise errors.RequestError(msg=t('error.sms.default_disabled'))
        config.is_default = True
        await db.flush()
        await sms_config_dao.clear_default(db, exclude_pk=pk)

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        return await sms_config_dao.delete(db, pk)

    @staticmethod
    def build_provider(config: SmsConfig) -> SmsProvider:
        """把一行配置变成一个可用的厂商实例（解密发生在这一刻，不落地）"""
        provider_cls = provider_or_raise(config.provider)
        secret = _cipher().decrypt(config.secret_cipher) if config.secret_cipher else None
        provider_config = build_provider_config(
            provider_cls, access_key_id=config.access_key_id, secret=secret, options=parse_options(config)
        )
        return provider_cls(provider_config, timeout=config.timeout)

    @classmethod
    async def test(cls, *, db: AsyncSession, pk: int, obj: TestSmsParam, user_id: int) -> SmsSendResultSchema:
        """发测试短信：选配置 + 号码 + 厂商模板 ID + 厂商侧参数，绕过业务模板，真发一条，写一条 `template = test` 的日志

        连不通 / 被拒是**测试结果**，不是接口失败：原样返回给前端显示（状态 + 错误类型 + 厂商码 + 厂商原文）
        """
        from backend.plugin.sms.service.sms_service import sms_service

        config = await cls.get(db=db, pk=pk)
        provider_cls = provider_or_raise(config.provider)
        if provider_cls.template_mapping is TemplateMapping.named and not isinstance(obj.params, Mapping):
            raise errors.RequestError(
                msg=t('error.sms.test_params_shape', shape='变量名', example='{"code": "123456"}')
            )
        if provider_cls.template_mapping is TemplateMapping.ordered and isinstance(obj.params, Mapping):
            raise errors.RequestError(msg=t('error.sms.test_params_shape', shape='位置', example='["123456", "5"]'))
        return await sms_service.send_test(
            config=config, phone=obj.phone, template_id=obj.template_id, params=obj.params, user_id=user_id
        )


sms_config_service: SmsConfigService = SmsConfigService()
