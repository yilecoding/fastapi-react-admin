"""流程定义：草稿 / 发布 / 版本（#107 设计 3 / 9）

- 编辑永远在草稿上做（`wf_definition.draft_*`），**保存草稿时不校验**
- 发布时才校验，有 ERROR 就拒绝；通过后把草稿**原样**拷进一条新的 version 行
- 在途实例拿的是自己的快照，改定义不影响它们
"""

from __future__ import annotations

import json

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from backend.common.exception import errors
from backend.common.i18n import t
from backend.plugin.workflow.engine.flow import validate_publish
from backend.plugin.workflow.enums import FORM_BIZ_TYPE, DefinitionStatus
from backend.plugin.workflow.handler import get_handler
from backend.plugin.workflow.model import WfDefinition, WfDefinitionVersion, WfInstance

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.plugin.workflow.schema.workflow import CreateDefinitionParam, UpdateDefinitionParam

#: 草稿 JSON 的体积上限。整份存进 TEXT，不限的话一次保存就能塞几十 MB
_MAX_JSON = 512 * 1024


def _dump(v: dict[str, Any]) -> str:
    s = json.dumps(v, ensure_ascii=False)
    if len(s) > _MAX_JSON:
        raise errors.RequestError(msg=t('error.workflow.definition_too_large'))
    return s


async def get(db: AsyncSession, pk: int) -> WfDefinition:
    d = await db.scalar(select(WfDefinition).where(WfDefinition.id == pk, WfDefinition.deleted == 0))
    if d is None:
        raise errors.NotFoundError(msg=t('error.workflow.definition_not_found'))
    return d


async def list_all(db: AsyncSession, *, name: str | None, status: str | None) -> list[WfDefinition]:
    stmt = select(WfDefinition).where(WfDefinition.deleted == 0)
    if name:
        stmt = stmt.where(WfDefinition.name.like(f'%{name}%'))
    if status:
        stmt = stmt.where(WfDefinition.status == status)
    return list((await db.scalars(stmt.order_by(WfDefinition.sort, WfDefinition.id))).all())


async def version_numbers(db: AsyncSession, version_ids: list[int]) -> dict[int, int]:
    """当前发布版本的版本号（列表上显示 v3）"""
    if not version_ids:
        return {}
    rows = await db.execute(
        select(WfDefinitionVersion.id, WfDefinitionVersion.version_no).where(WfDefinitionVersion.id.in_(version_ids))
    )
    return dict(rows.all())


async def create(db: AsyncSession, obj: CreateDefinitionParam) -> WfDefinition:
    if await db.scalar(select(WfDefinition.id).where(WfDefinition.code == obj.code, WfDefinition.deleted == 0)):
        raise errors.ConflictError(msg=t('error.workflow.definition_code_exists'))
    try:
        get_handler(obj.biz_type)
    except LookupError:
        raise errors.RequestError(msg=t('error.workflow.biz_type_unknown', biz_type=obj.biz_type)) from None
    d = WfDefinition(
        code=obj.code,
        name=obj.name,
        biz_type=obj.biz_type,
        category=obj.category,
        icon=obj.icon,
        description=obj.description,
        sort=obj.sort,
    )
    if obj.form is not None:
        d.draft_form_json = _dump(obj.form)
    if obj.model is not None:
        d.draft_model_json = _dump(obj.model)
    db.add(d)
    await db.flush()
    return d


async def update(db: AsyncSession, pk: int, obj: UpdateDefinitionParam) -> None:
    d = await get(db, pk)
    data = obj.model_dump(exclude_unset=True)
    for k in ('name', 'category', 'icon', 'description', 'sort'):
        if k in data:
            setattr(d, k, data[k])
    if obj.form is not None:
        d.draft_form_json = _dump(obj.form)
    if obj.model is not None:
        d.draft_model_json = _dump(obj.model)


async def delete(db: AsyncSession, pk: int) -> None:
    """有过实例的定义不让删：审批中心里的历史单据还要按它显示名称。停用就够了"""
    d = await get(db, pk)
    if await db.scalar(select(func.count()).select_from(WfInstance).where(WfInstance.definition_id == pk)):
        raise errors.ConflictError(msg=t('error.workflow.definition_has_instances'))
    d.deleted = d.id


def check(d: WfDefinition) -> list[dict[str, str]]:
    return validate_publish(json.loads(d.draft_form_json), json.loads(d.draft_model_json))


async def publish(
    db: AsyncSession, pk: int, user_id: int
) -> tuple[WfDefinitionVersion | None, list[dict[str, str]], bool]:
    """发布草稿。返回 (版本, 校验问题, 是否真的新出了一个版本)。

    草稿和当前版本**一字不差**时不再出新版本：反复点「发布」会刷出一串内容相同的 v3 v4 v5，
    版本历史就没法看了。停用状态下点发布 = 重新启用当前版本。
    """
    d = await get(db, pk)
    issues = check(d)
    if any(i['level'] == 'ERROR' for i in issues):
        return None, issues, False
    if d.current_version_id is not None:
        cur = await db.get(WfDefinitionVersion, d.current_version_id)
        if cur is not None and cur.form_json == d.draft_form_json and cur.model_json == d.draft_model_json:
            d.status = DefinitionStatus.published
            return cur, issues, False
    last = await db.scalar(
        select(func.coalesce(func.max(WfDefinitionVersion.version_no), 0)).where(
            WfDefinitionVersion.definition_id == pk
        )
    )
    v = WfDefinitionVersion(
        definition_id=pk,
        version_no=last + 1,
        # 原样拷贝，不经过解析再序列化
        form_json=d.draft_form_json,
        model_json=d.draft_model_json,
        published_by=user_id,
    )
    db.add(v)
    await db.flush()
    d.current_version_id = v.id
    d.status = DefinitionStatus.published
    return v, issues, True


async def set_enabled(db: AsyncSession, pk: int, *, enabled: bool) -> None:
    d = await get(db, pk)
    if enabled:
        if d.current_version_id is None:
            raise errors.ConflictError(msg=t('error.workflow.definition_never_published'))
        d.status = DefinitionStatus.published
    else:
        d.status = DefinitionStatus.disabled


async def versions(db: AsyncSession, pk: int) -> list[WfDefinitionVersion]:
    await get(db, pk)
    stmt = (
        select(WfDefinitionVersion)
        .where(WfDefinitionVersion.definition_id == pk)
        .order_by(WfDefinitionVersion.version_no.desc())
    )
    return list((await db.scalars(stmt)).all())


async def startable(db: AsyncSession) -> list[WfDefinition]:
    """发起页：已发布的表单审批。业务审批由业务页面发起，不出现在这里"""
    stmt = (
        select(WfDefinition)
        .where(
            WfDefinition.deleted == 0,
            WfDefinition.status == DefinitionStatus.published,
            WfDefinition.biz_type == FORM_BIZ_TYPE,
        )
        .order_by(WfDefinition.sort, WfDefinition.id)
    )
    return list((await db.scalars(stmt)).all())
