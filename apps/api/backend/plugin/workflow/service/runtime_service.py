"""审批运行时（#107 设计 4 / 5）

## 并发护栏

所有改实例状态的动作都走 `execute()`：

1. 查幂等键，命中就重放上次的结果
2. **先认领实例**：`UPDATE wf_instance SET version=version+1 WHERE id=? AND version=? AND status='running'`。
   它是这张单的互斥点 —— 同一实例上的两个动作在这一句上串行（第二个阻塞到第一个提交，
   然后 WHERE 不再成立）。认领失败就整个事务重来一遍（最多 3 次），重新读状态再判断
3. 再改待办（同样带版本号的条件 UPDATE）、推进节点

🔴 **认领必须在动待办之前。** 反过来（先改自己的待办，再数「会签还剩几个人」）
在 SQL Server 默认的 READ COMMITTED 下会死锁：A 锁着自己的待办行去读 B 的，
B 锁着自己的去读 A 的。先认领实例，两个人根本到不了第二步。

为什么不用 `SELECT … FOR UPDATE`：全仓一处都没用过，SQL Server 方言生成什么锁提示也没验证过；
条件 UPDATE 三个方言都是标准 SQL。每次都 `version+1`，不会撞上「更新成相同值时 MySQL
rowcount 为 0」那个坑（根 CLAUDE.md）。

## 被拒绝的动作也记

`ActionRejected` 让主事务整体回滚，然后**另开一个事务**写一条 `result=rejected` 的记录。
"""

from __future__ import annotations

import json
import uuid

from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.socketio.actions import notification_new, workflow_todo_changed
from backend.plugin.notification.crud.crud_notification import notification_dao
from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.schema.notification import CreateNotificationParam
from backend.plugin.workflow.engine import assignee as assignee_rules
from backend.plugin.workflow.engine.flow import condition_variables, index_nodes, pick_branch
from backend.plugin.workflow.engine.form import (
    FormDataError,
    editable_fields,
    start_editable_fields,
    validate_form_data,
)
from backend.plugin.workflow.enums import (
    FORM_BIZ_TYPE,
    PERM_TERMINATE,
    Action,
    ActorType,
    ApprovalMode,
    DefinitionStatus,
    InstanceStatus,
    OnEmpty,
    TaskStatus,
)
from backend.plugin.workflow.handler import FinishEvent, get_handler
from backend.plugin.workflow.model import WfActionRecord, WfCc, WfDefinition, WfDefinitionVersion, WfInstance, WfTask
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncSession

#: 催办节流（#107：5 分钟）
REMIND_INTERVAL = timedelta(minutes=5)
_MAX_ATTEMPTS = 3


# ── 调用方身份 ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Actor:
    id: int
    nickname: str
    dept_id: int | None
    is_superuser: bool
    perms: frozenset[str]

    def has(self, perm: str) -> bool:
        return self.is_superuser or perm in self.perms

    @classmethod
    def from_user(cls, user: Any) -> Actor:
        """从 `request.user`（`GetUserInfoWithRelationDetail`）取。权限码的算法和 `rbac_verify` 一致"""
        perms: set[str] = set()
        for role in getattr(user, 'roles', None) or []:
            if role.status != 1:
                continue
            for menu in role.menus or []:
                if menu.perms and menu.status == 1:
                    perms.update(menu.perms.split(','))
        return cls(
            id=user.id,
            nickname=user.nickname,
            dept_id=user.dept_id,
            is_superuser=bool(user.is_superuser),
            perms=frozenset(perms),
        )


class ActionRejected(errors.ConflictError):
    """动作被拒绝：状态不允许、没有权限、已被他人处理……会落一条 rejected 记录"""

    def __init__(self, key: str, *, instance_id: int | None = None, **kwargs: Any) -> None:
        super().__init__(msg=t(f'error.workflow.{key}', **kwargs))
        self.key = key
        self.instance_id = instance_id


class _RetryError(Exception):
    """认领实例失败：别人刚改过。重读状态再来一遍"""


# ── 事务内的上下文 ───────────────────────────────────────────────────────────


@dataclass
class _Ctx:
    db: AsyncSession
    actor_id: int | None
    #: 提交之后才执行的副作用（socket 推送）。通知的**行**在事务里写 —— 回滚就一起没了
    effects: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    def push_todo(self, user_ids: list[int]) -> None:
        for uid in dict.fromkeys(user_ids):
            self.effects.append(lambda uid=uid: workflow_todo_changed(uid))

    async def notify(self, user_ids: list[int], title: str, content: str, link: str) -> None:
        """站内通知。🔴 **自己的动作不通知自己**（avc-bp：「用户点的是『取消会议』，收到的却是『已撤回』」）"""
        for uid in dict.fromkeys(user_ids):
            if uid == self.actor_id:
                continue
            await notification_dao.create(
                self.db,
                CreateNotificationParam(
                    title=title[:128],
                    content=content,
                    category=NotificationCategory.WORKFLOW,
                    link=link,
                    recipient_id=uid,
                ),
            )
            self.effects.append(lambda uid=uid: notification_new(uid))


def detail_link(instance_id: int) -> str:
    return f'/workflow/inbox?id={instance_id}'


async def _run_effects(effects: list[Callable[[], Awaitable[None]]]) -> None:
    """推送失败不影响结果：数据已经提交，前端下次拉取照样对（同 `notification_service._push`）"""
    for eff in effects:
        try:
            await eff()
        except Exception as e:  # ruff:ignore[try-except-in-loop]
            log.warning(f'审批推送失败（不影响结果）：{e!s}')


# ── 快照读取 ─────────────────────────────────────────────────────────────────


def _json(s: str | None) -> Any:
    return json.loads(s) if s else {}


async def _load_instance(db: AsyncSession, pk: int) -> WfInstance:
    inst = await db.scalar(select(WfInstance).where(WfInstance.id == pk).execution_options(populate_existing=True))
    if inst is None:
        raise errors.NotFoundError(msg=t('error.workflow.instance_not_found'))
    return inst


async def _claim(db: AsyncSession, inst: WfInstance) -> None:
    """认领实例（见模块头注释）。成功后本地的 version 跟着 +1"""
    res = await db.execute(
        update(WfInstance)
        .where(
            WfInstance.id == inst.id,
            WfInstance.version == inst.version,
            WfInstance.status == InstanceStatus.running,
        )
        .values(version=WfInstance.version + 1)
        .execution_options(synchronize_session=False)
    )
    if res.rowcount != 1:
        current = await db.scalar(select(WfInstance.status).where(WfInstance.id == inst.id))
        if current != InstanceStatus.running:
            raise ActionRejected('instance_finished', instance_id=inst.id)
        raise _RetryError
    # 让 ORM 对象和库里一致；之后 flush 时写的是同一个值
    inst.version += 1


async def _pending_tasks(db: AsyncSession, instance_id: int, node_id: str | None = None) -> list[WfTask]:
    stmt = select(WfTask).where(WfTask.instance_id == instance_id, WfTask.status == TaskStatus.pending)
    if node_id is not None:
        stmt = stmt.where(WfTask.node_id == node_id)
    return list((await db.scalars(stmt.order_by(WfTask.id).execution_options(populate_existing=True))).all())


async def _close_task(
    db: AsyncSession, task: WfTask, status: TaskStatus, decision: str | None, opinion: str | None
) -> None:
    res = await db.execute(
        update(WfTask)
        .where(WfTask.id == task.id, WfTask.version == task.version, WfTask.status == TaskStatus.pending)
        .values(
            status=status,
            decision=decision,
            opinion=opinion,
            version=WfTask.version + 1,
            finished_time=timezone.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if res.rowcount != 1:
        # 实例已经认领过了，这里还失败只可能是读到的待办过期了 —— 重来
        raise _RetryError
    task.status, task.decision, task.opinion, task.version = status, decision, opinion, task.version + 1


def _record(
    ctx: _Ctx,
    inst: WfInstance,
    action: str,
    *,
    key: str | None = None,
    actor_type: ActorType = ActorType.user,
    actor_id: int | None = None,
    actor_name: str | None = None,
    task: WfTask | None = None,
    node: dict[str, Any] | None = None,
    target: list[tuple[int, str]] | None = None,
    opinion: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    ctx.db.add(
        WfActionRecord(
            instance_id=inst.id,
            task_id=task.id if task else None,
            node_id=(node or {}).get('id') or (task.node_id if task else None),
            node_name=(node or {}).get('name') or (task.node_name if task else None),
            action=action,
            actor_type=actor_type,
            actor_id=actor_id,
            actor_name=actor_name,
            target_user_id=target[0][0] if target and len(target) == 1 else None,
            target_user_name='、'.join(n for _, n in target)[:256] if target else None,
            opinion=opinion,
            result='ok',
            reject_reason=None,
            # 系统动作没有客户端幂等键，生成一个占位 —— 列是 NOT NULL + 唯一
            idempotency_key=key or f'sys:{uuid.uuid4().hex}',
            detail=json.dumps(detail, ensure_ascii=False) if detail else None,
        )
    )


# ── 推进 ─────────────────────────────────────────────────────────────────────


async def _finish(ctx: _Ctx, inst: WfInstance, status: InstanceStatus, opinion: str | None) -> None:
    """实例到终态：作废剩余待办、清 active_key、回调业务、通知发起人"""
    for task in await _pending_tasks(ctx.db, inst.id):
        await _close_task(ctx.db, task, TaskStatus.canceled, None, None)
        ctx.push_todo([task.assignee_id])
    inst.status = status
    inst.current_node_id = None
    inst.active_key = None
    inst.finished_time = timezone.now()
    await get_handler(inst.biz_type).on_finished(
        ctx.db, inst.biz_id, FinishEvent(status=status, opinion=opinion, actor_id=ctx.actor_id)
    )
    if status in {InstanceStatus.approved, InstanceStatus.rejected, InstanceStatus.terminated}:
        word = t(f'workflow.status.{InstanceStatus(status).value}')
        await ctx.notify(
            [inst.initiator_id],
            f'{inst.title}：{word}',
            opinion or word,
            detail_link(inst.id),
        )


async def _advance(ctx: _Ctx, inst: WfInstance, start_from: dict[str, Any] | None) -> None:  # ruff:ignore[complex-structure]
    """从 `start_from` 开始往下走，直到停在一个有人可办的审批节点上，或者走到结束"""
    model = _json(inst.model_snapshot)
    nodes = index_nodes(model)
    form_data = _json(inst.form_data)
    variables = _json(inst.variables)
    cond_vars = condition_variables(form_data, inst.initiator_dept_id)
    selected: dict[str, list[str]] = variables.get('selected') or {}

    node = start_from
    while node is not None:
        kind = node['type']
        if kind == 'condition':
            br = pick_branch(node, cond_vars)
            _record(
                ctx,
                inst,
                'branch',
                actor_type=ActorType.system,
                node=node,
                detail={'branch': br['id'], 'name': br['name']},
            )
            node = br.get('child') or nodes[node['id']].after
            continue
        if kind == 'cc':
            users: list[tuple[int, str]] = []
            for rule in node.get('targets') or []:
                users += await assignee_rules.resolve(
                    ctx.db,
                    rule,
                    initiator_id=inst.initiator_id,
                    initiator_dept_id=inst.initiator_dept_id,
                    form_data=form_data,
                    selected=selected,
                    node_id=node['id'],
                )
            users = list(dict.fromkeys(users))
            added = await _add_cc(ctx, inst, users, node_id=node['id'], from_user_id=None)
            if added:
                _record(ctx, inst, 'cc', actor_type=ActorType.system, node=node, target=added)
            node = nodes[node['id']].after
            continue

        # approval
        users = await assignee_rules.resolve(
            ctx.db,
            node.get('assignee') or {},
            initiator_id=inst.initiator_id,
            initiator_dept_id=inst.initiator_dept_id,
            form_data=form_data,
            selected=selected,
            node_id=node['id'],
        )
        if not users:
            on_empty = OnEmpty(node.get('onEmpty') or OnEmpty.reject)
            if on_empty == OnEmpty.skip:
                _record(ctx, inst, 'skip', actor_type=ActorType.system, node=node, opinion=t('workflow.no_assignee'))
                node = nodes[node['id']].after
                continue
            if on_empty == OnEmpty.admin:
                users = await assignee_rules.superusers(ctx.db)
            if not users:
                reason = t('workflow.no_assignee_reject', node=node['name'])
                _record(ctx, inst, 'auto_reject', actor_type=ActorType.system, node=node, opinion=reason)
                await _finish(ctx, inst, InstanceStatus.rejected, reason)
                return

        for uid, name in users:
            ctx.db.add(
                WfTask(
                    instance_id=inst.id,
                    node_id=node['id'],
                    node_name=node['name'],
                    assignee_id=uid,
                    assignee_name=name,
                    origin_assignee_id=None,
                    status=TaskStatus.pending,
                )
            )
        inst.current_node_id = node['id']
        ctx.push_todo([u for u, _ in users])
        return

    await _finish(ctx, inst, InstanceStatus.approved, None)


async def _add_cc(
    ctx: _Ctx, inst: WfInstance, users: list[tuple[int, str]], *, node_id: str | None, from_user_id: int | None
) -> list[tuple[int, str]]:
    """抄送并通知（avc-bp：抄送「此前 100% 静默」）。已经抄送过的人不重复"""
    if not users:
        return []
    existing = set((await ctx.db.scalars(select(WfCc.user_id).where(WfCc.instance_id == inst.id))).all())
    added = [(u, n) for u, n in users if u not in existing and u != inst.initiator_id]
    for uid, _ in added:
        ctx.db.add(WfCc(instance_id=inst.id, user_id=uid, node_id=node_id, from_user_id=from_user_id))
    await ctx.notify(
        [u for u, _ in added],
        t('workflow.notify.cc_title', title=inst.title),
        inst.summary or inst.title,
        detail_link(inst.id),
    )
    return added


# ── 能力信封 ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Capability:
    action: Action
    enabled: bool
    reason: str | None = None


async def capabilities(db: AsyncSession, inst: WfInstance, actor: Actor) -> tuple[list[Capability], WfTask | None]:
    """可用动作 = 平台支持 ∩ 业务默认集 ∩ 节点配置，再叠加：待办是否 pending · 我是谁。

    🔴 **详情接口和执行接口用的是同一个函数**（avc-bp：「配置天然有服务端强制力，不是隐藏按钮」）。
    前端只按这里渲染按钮，不准自己根据实例状态推导。
    """
    caps: list[Capability] = []
    if inst.status != InstanceStatus.running:
        return caps, None

    my_task = None
    if inst.current_node_id:
        for task in await _pending_tasks(db, inst.id, inst.current_node_id):
            if task.assignee_id == actor.id:
                my_task = task
                break

    if my_task is not None:
        caps += [Capability(Action.approve, True), Capability(Action.reject, True)]
        node = index_nodes(_json(inst.model_snapshot))[my_task.node_id].node
        configured = node.get('actions')
        allowed = get_handler(inst.biz_type).default_actions
        if configured is not None:
            allowed = allowed & {Action(a) for a in configured}
        caps += [Capability(a, True) for a in (Action.transfer, Action.cc) if a in allowed]

    if inst.initiator_id == actor.id:
        caps.append(Capability(Action.withdraw, True))
        last = await db.scalar(
            select(func.max(WfActionRecord.created_time)).where(
                WfActionRecord.instance_id == inst.id,
                WfActionRecord.action == Action.remind,
                WfActionRecord.result == 'ok',
            )
        )
        if last is not None and timezone.now() - last < REMIND_INTERVAL:
            caps.append(Capability(Action.remind, False, t('error.workflow.remind_too_often')))
        else:
            caps.append(Capability(Action.remind, True))

    # avc-bp 的终止要求当前用户是办理人，管理员反而终止不了。这里改成管理员
    if actor.has(PERM_TERMINATE):
        caps.append(Capability(Action.terminate, True))
    return caps, my_task


def _require(caps: list[Capability], action: Action, inst: WfInstance) -> None:
    for c in caps:
        if c.action == action:
            if not c.enabled:
                raise ActionRejected('action_disabled', instance_id=inst.id, reason=c.reason or '')
            return
    raise ActionRejected('action_not_allowed', instance_id=inst.id)


# ── 入口 ─────────────────────────────────────────────────────────────────────


async def _replay(db: AsyncSession, key: str) -> dict[str, Any] | None:
    rec = await db.scalar(select(WfActionRecord).where(WfActionRecord.idempotency_key == key))
    if rec is None:
        return None
    if rec.result != 'ok':
        raise errors.ConflictError(msg=rec.reject_reason or t('error.workflow.action_not_allowed'))
    return {'instance_id': rec.instance_id, 'replayed': True}


async def _record_rejection(
    db: AsyncSession, key: str, instance_id: int, action: str, actor: Actor, reason: str
) -> None:
    try:
        async with db.begin():
            db.add(
                WfActionRecord(
                    instance_id=instance_id,
                    task_id=None,
                    node_id=None,
                    node_name=None,
                    action=action,
                    actor_type=ActorType.user,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    target_user_id=None,
                    target_user_name=None,
                    opinion=None,
                    result='rejected',
                    reject_reason=reason[:256],
                    idempotency_key=key,
                    detail=None,
                )
            )
    except IntegrityError:
        # 同一个幂等键并发提交了两次，另一次已经记下了
        log.info(f'审批动作拒绝记录重复：{key}')


async def execute(  # ruff:ignore[complex-structure]
    db: AsyncSession,
    *,
    key: str,
    action: str,
    actor: Actor,
    body: Callable[[_Ctx], Awaitable[int]],
) -> dict[str, Any]:
    """所有动作的统一入口（见模块头注释）。`db` 必须是**不带事务**的会话（`CurrentSession`）。

    :return: `{'instance_id': ..., 'replayed': bool}`
    """
    if not key or len(key) > 64:
        raise errors.RequestError(msg=t('error.workflow.idempotency_key_invalid'))
    for _ in range(_MAX_ATTEMPTS):
        # 依赖注入里可能已经隐式开了一个只读事务（autobegin），先收掉
        if db.in_transaction():
            await db.rollback()
        ctx = _Ctx(db=db, actor_id=actor.id)
        try:
            async with db.begin():
                replay = await _replay(db, key)
                if replay is not None:
                    return replay
                instance_id = await body(ctx)
        except _RetryError:
            continue
        except ActionRejected as e:
            if e.instance_id is not None:
                await _record_rejection(db, key, e.instance_id, action, actor, e.msg)
            raise
        except IntegrityError:
            # 幂等键撞了唯一约束：同一个键并发提交，另一边先落库了 —— 重放它的结果
            if db.in_transaction():
                await db.rollback()
            async with db.begin():
                replay = await _replay(db, key)
            if replay is not None:
                return replay
            raise
        await _run_effects(ctx.effects)
        return {'instance_id': instance_id, 'replayed': False}
    raise ActionRejected('busy')


# ── 发起 ─────────────────────────────────────────────────────────────────────


async def published_definition(db: AsyncSession, code: str) -> tuple[WfDefinition, WfDefinitionVersion]:
    d = await db.scalar(select(WfDefinition).where(WfDefinition.code == code, WfDefinition.deleted == 0))
    if d is None or d.status != DefinitionStatus.published or d.current_version_id is None:
        raise errors.NotFoundError(msg=t('error.workflow.definition_not_startable'))
    v = await db.get(WfDefinitionVersion, d.current_version_id)
    if v is None:
        raise errors.NotFoundError(msg=t('error.workflow.definition_not_startable'))
    return d, v


async def start_in_tx(
    ctx: _Ctx,
    *,
    definition: WfDefinition,
    version: WfDefinitionVersion,
    actor: Actor,
    form_data: dict[str, Any],
    selected: dict[str, list[str]],
    biz_id: int | None,
    key: str | None,
) -> WfInstance:
    """在调用方的事务里发起。业务审批由业务自己的事务调这个：流程起不来就整单回滚"""
    db = ctx.db
    handler = get_handler(definition.biz_type)
    await handler.assert_start_allowed(db, biz_id, actor.id)
    form_schema = _json(version.form_json)
    model = _json(version.model_json)
    nodes = index_nodes(model)
    # 只收发起人能填的字段：开始节点上 hidden / readonly 的（留给审批人填的那种）直接不收，
    # 必填校验也不算它们 —— 否则「人事备注」必填就没人发得起来
    try:
        data = validate_form_data(form_schema, form_data, only=start_editable_fields(form_schema, model['root']))
    except FormDataError as e:
        raise errors.RequestError(msg=t('error.workflow.form_invalid', detail=str(e)), data=e.errors) from e

    # 自选审批人：只收「这个节点确实是 select_on_start」的，其余的丢掉
    clean_selected: dict[str, list[str]] = {}
    for nid, ids in (selected or {}).items():
        ref = nodes.get(nid)
        if ref and ref.node['type'] == 'approval' and (ref.node.get('assignee') or {}).get('kind') == 'select_on_start':
            if not isinstance(ids, list) or not all(isinstance(x, str) and x.isdigit() for x in ids):
                raise errors.RequestError(msg=t('error.workflow.selected_invalid'))
            clean_selected[nid] = ids
    for ref in nodes.values():
        n = ref.node
        is_select = n['type'] == 'approval' and (n.get('assignee') or {}).get('kind') == 'select_on_start'
        if is_select and not clean_selected.get(n['id']):
            raise errors.RequestError(msg=t('error.workflow.selected_required', node=n['name']))

    snap = await handler.snapshot(db, biz_id, data)
    seq = 1
    active_key = None
    if definition.biz_type != FORM_BIZ_TYPE:
        active_key = f'{definition.biz_type}:{biz_id}'
        seq = (
            await db.scalar(
                select(func.coalesce(func.max(WfInstance.seq), 0)).where(
                    WfInstance.biz_type == definition.biz_type, WfInstance.biz_id == biz_id
                )
            )
        ) + 1

    inst = WfInstance(
        definition_id=definition.id,
        version_id=version.id,
        biz_type=definition.biz_type,
        biz_id=biz_id,
        seq=seq,
        title=snap.title or t('workflow.default_title', name=definition.name, user=actor.nickname),
        summary=snap.summary or _summary(form_schema, data),
        initiator_id=actor.id,
        initiator_dept_id=actor.dept_id,
        status=InstanceStatus.running,
        current_node_id=None,
        # 原样拷贝，不经过任何解析 —— 见 engine/schema.py 头注释
        form_snapshot=version.form_json,
        model_snapshot=version.model_json,
        form_data=json.dumps(data, ensure_ascii=False),
        variables=json.dumps({'selected': clean_selected}, ensure_ascii=False),
        active_key=active_key,
    )
    db.add(inst)
    await db.flush()
    _record(ctx, inst, 'start', key=key, actor_id=actor.id, actor_name=actor.nickname)
    await _advance(ctx, inst, nodes[model['root']['id']].after)
    return inst


def _summary(form_schema: dict[str, Any], data: dict[str, Any]) -> str | None:
    """前三个有值的简单字段拼成一行，审批中心列表里显示"""
    parts = []
    for f in form_schema.get('fields') or []:
        v = data.get(f['id'])
        if v in (None, '', []) or f['type'] in {'table', 'attachment', 'user', 'dept', 'description'}:
            continue
        if f['type'] == 'select':
            v = next((o['label'] for o in f.get('options') or [] if o['value'] == v), v)
        if isinstance(v, list):
            v = ' ~ '.join(map(str, v)) if f['type'] == 'daterange' else '、'.join(map(str, v))
        parts.append(f'{f["label"]}：{v}')
        if len(parts) == 3:
            break
    return '；'.join(parts)[:512] or None


async def start_form(
    db: AsyncSession,
    *,
    code: str,
    actor: Actor,
    form_data: dict[str, Any],
    selected: dict[str, list[str]],
    key: str,
) -> dict[str, Any]:
    async def body(ctx: _Ctx) -> int:
        d, v = await published_definition(ctx.db, code)
        if d.biz_type != FORM_BIZ_TYPE:
            raise errors.RequestError(msg=t('error.workflow.not_form_definition'))
        inst = await start_in_tx(
            ctx, definition=d, version=v, actor=actor, form_data=form_data, selected=selected, biz_id=None, key=key
        )
        return inst.id

    return await execute(db, key=key, action='start', actor=actor, body=body)


async def start_for_biz(
    db: AsyncSession, *, code: str, biz_id: int, actor: Actor, variables: dict[str, Any] | None = None
) -> tuple[WfInstance, list[Callable[[], Awaitable[None]]]]:
    """业务审批：在业务**自己的事务**里调。返回实例和提交后要跑的推送（业务提交后调 `run_effects`）"""
    d, v = await published_definition(db, code)
    ctx = _Ctx(db=db, actor_id=actor.id)
    inst = await start_in_tx(
        ctx, definition=d, version=v, actor=actor, form_data=variables or {}, selected={}, biz_id=biz_id, key=None
    )
    return inst, ctx.effects


run_effects = _run_effects


# ── 动作 ─────────────────────────────────────────────────────────────────────


async def act(  # ruff:ignore[complex-structure]
    db: AsyncSession,
    *,
    instance_id: int,
    action: Action,
    actor: Actor,
    key: str,
    opinion: str | None = None,
    target_user_ids: list[int] | None = None,
    form_patch: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # 接口层的 SchemaBase 会把枚举还原成 str —— 这里统一回枚举，后面 match / .value 都按枚举写
    action = Action(action)
    opinion = (opinion or '').strip() or None

    async def body(ctx: _Ctx) -> int:  # ruff:ignore[complex-structure]
        inst = await _load_instance(ctx.db, instance_id)
        if inst.status != InstanceStatus.running:
            raise ActionRejected('instance_finished', instance_id=inst.id)

        if action == Action.remind:
            # 催办不改实例状态，不认领 —— 两个人同时催只会多一条通知
            caps, _ = await capabilities(ctx.db, inst, actor)
            _require(caps, action, inst)
            pending = await _pending_tasks(ctx.db, inst.id)
            await ctx.notify(
                [t_.assignee_id for t_ in pending],
                t('workflow.notify.remind_title', title=inst.title),
                t('workflow.notify.remind_content', user=actor.nickname),
                detail_link(inst.id),
            )
            _record(ctx, inst, action, key=key, actor_id=actor.id, actor_name=actor.nickname)
            return inst.id

        await _claim(ctx.db, inst)
        caps, my_task = await capabilities(ctx.db, inst, actor)
        _require(caps, action, inst)
        nodes = index_nodes(_json(inst.model_snapshot))

        match action:
            case Action.approve:
                assert my_task is not None
                node = nodes[my_task.node_id].node
                # 不传改动也要走一遍：这个节点上「可编辑 + 必填」的字段没填，不许同意
                detail = _apply_form_patch(inst, node, form_patch or {})
                await _close_task(ctx.db, my_task, TaskStatus.done, 'approve', opinion)
                _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    opinion=opinion,
                    detail=detail,
                )
                rest = await _pending_tasks(ctx.db, inst.id, my_task.node_id)
                mode = ApprovalMode(node.get('mode') or ApprovalMode.any)
                if mode == ApprovalMode.any or not rest:
                    for other in rest:
                        await _close_task(ctx.db, other, TaskStatus.canceled, None, None)
                        ctx.push_todo([other.assignee_id])
                    await _advance(ctx, inst, nodes[my_task.node_id].after)
                ctx.push_todo([actor.id])

            case Action.reject:
                assert my_task is not None
                if not opinion:
                    raise errors.RequestError(msg=t('error.workflow.opinion_required'))
                await _close_task(ctx.db, my_task, TaskStatus.done, 'reject', opinion)
                _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    opinion=opinion,
                )
                ctx.push_todo([actor.id])
                # 一票否决：会签里任何一人驳回，整个实例结束
                await _finish(ctx, inst, InstanceStatus.rejected, opinion)

            case Action.withdraw:
                if not opinion:
                    # avc-bp：「不再兜底填『发起人撤回』」
                    raise errors.RequestError(msg=t('error.workflow.reason_required'))
                approvers = list(
                    (
                        await ctx.db.scalars(
                            select(WfTask.assignee_id).where(
                                WfTask.instance_id == inst.id, WfTask.decision == 'approve'
                            )
                        )
                    ).all()
                )
                _record(ctx, inst, action, key=key, actor_id=actor.id, actor_name=actor.nickname, opinion=opinion)
                await _finish(ctx, inst, InstanceStatus.withdrawn, opinion)
                # avc-bp 还没做的：「撤回作废已完成的审批，但没有任何人被告知」
                await ctx.notify(
                    approvers,
                    t('workflow.notify.withdrawn_title', title=inst.title),
                    opinion,
                    detail_link(inst.id),
                )

            case Action.terminate:
                if not opinion:
                    raise errors.RequestError(msg=t('error.workflow.reason_required'))
                _record(ctx, inst, action, key=key, actor_id=actor.id, actor_name=actor.nickname, opinion=opinion)
                await _finish(ctx, inst, InstanceStatus.terminated, opinion)

            case Action.transfer:
                assert my_task is not None
                if not target_user_ids or len(target_user_ids) != 1:
                    raise errors.RequestError(msg=t('error.workflow.transfer_one'))
                users = await assignee_rules.users_by_ids(ctx.db, target_user_ids)
                if not users:
                    raise errors.RequestError(msg=t('error.workflow.user_not_found'))
                target_id, target_name = users[0]
                if target_id == inst.initiator_id:
                    raise ActionRejected('transfer_to_initiator', instance_id=inst.id)
                on_node = {t_.assignee_id for t_ in await _pending_tasks(ctx.db, inst.id, my_task.node_id)}
                if target_id in on_node:
                    raise ActionRejected('transfer_to_existing', instance_id=inst.id)
                await _close_task(ctx.db, my_task, TaskStatus.transferred, None, opinion)
                ctx.db.add(
                    WfTask(
                        instance_id=inst.id,
                        node_id=my_task.node_id,
                        node_name=my_task.node_name,
                        assignee_id=target_id,
                        assignee_name=target_name,
                        origin_assignee_id=my_task.origin_assignee_id or actor.id,
                        status=TaskStatus.pending,
                    )
                )
                _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    target=users,
                    opinion=opinion,
                )
                ctx.push_todo([actor.id, target_id])

            case Action.cc:
                assert my_task is not None
                users = await assignee_rules.users_by_ids(ctx.db, target_user_ids or [])
                if not users:
                    raise errors.RequestError(msg=t('error.workflow.user_not_found'))
                added = await _add_cc(ctx, inst, users, node_id=my_task.node_id, from_user_id=actor.id)
                _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    target=added or users,
                    opinion=opinion,
                )
        return inst.id

    return await execute(db, key=key, action=action.value, actor=actor, body=body)


def _apply_form_patch(inst: WfInstance, node: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """审批时改表单：🔴 **只收这个节点上 editable 的字段**，其余的直接拒绝（不是静默丢掉 ——
    静默丢掉的话前端以为改成功了）。

    校验只针对本节点可编辑的字段（含必填）：别的字段是发起人 / 前面的节点填的，这里没有
    改它们的权利，也就不该因为它们挡住这一步。前后差异记进轨迹。
    """
    form_schema = _json(inst.form_snapshot)
    allowed = editable_fields(form_schema, node)
    illegal = set(patch) - allowed
    if illegal:
        raise ActionRejected('field_not_editable', instance_id=inst.id, fields='、'.join(sorted(illegal)))
    if not allowed:
        return {}
    before = _json(inst.form_data)
    try:
        edited = validate_form_data(form_schema, {**before, **patch}, only=allowed)
    except FormDataError as e:
        raise errors.RequestError(msg=t('error.workflow.form_invalid', detail=str(e)), data=e.errors) from e
    data = {**{k: v for k, v in before.items() if k not in allowed}, **edited}
    changes = {k: {'from': before.get(k), 'to': data.get(k)} for k in allowed if before.get(k) != data.get(k)}
    inst.form_data = json.dumps(data, ensure_ascii=False)
    return {'form_changes': changes} if changes else {}
