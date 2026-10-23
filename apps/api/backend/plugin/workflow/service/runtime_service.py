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
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, false, func, select, update
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
    is_bigint_id,
    start_editable_fields,
    validate_form_data,
)
from backend.plugin.workflow.engine.simulate import simulate
from backend.plugin.workflow.enums import (
    FORM_BIZ_TYPE,
    PERM_MONITOR,
    PERM_REASSIGN,
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
from backend.plugin.workflow.model import (
    WfActionRecord,
    WfCc,
    WfDefinition,
    WfDefinitionVersion,
    WfDraft,
    WfInstance,
    WfTask,
)
from backend.plugin.workflow.service import ai_review_service
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from datetime import datetime

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


#: 给 `timeout_service` 用的公开名字：定时任务撞上「有人正在办这张单」时跳过，下一轮再看
RetryLater = _RetryError


# ── 事务内的上下文 ───────────────────────────────────────────────────────────


@dataclass
class _Ctx:
    db: AsyncSession
    actor_id: int | None
    #: 提交之后才执行的副作用（socket 推送）。通知的**行**在事务里写 —— 回滚就一起没了
    effects: list[Callable[[], Awaitable[None]]] = field(default_factory=list)
    #: 这个事务里新建的待办（拿回要知道「我这次同意之后冒出来了哪些待办」）
    spawned: list[WfTask] = field(default_factory=list)

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
) -> WfActionRecord:
    rec = WfActionRecord(
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
    ctx.db.add(rec)
    return rec


def _new_task(
    ctx: _Ctx,
    inst: WfInstance,
    node_id: str,
    node_name: str,
    user: tuple[int, str],
    *,
    batch: int,
    origin: int | None = None,
) -> WfTask:
    task = WfTask(
        instance_id=inst.id,
        node_id=node_id,
        node_name=node_name,
        assignee_id=user[0],
        assignee_name=user[1],
        origin_assignee_id=origin,
        status=TaskStatus.pending,
        batch=batch,
    )
    ctx.db.add(task)
    ctx.spawned.append(task)
    return task


def _set_var(inst: WfInstance, key: str, value: Any) -> None:
    variables = _json(inst.variables)
    variables[key] = value
    inst.variables = json.dumps(variables, ensure_ascii=False)


def _queue(inst: WfInstance, node_id: str) -> list[tuple[int, str]]:
    """依次审批节点进入时排好的顺序（进入那一刻解析，之后不再重算 —— 中途改了角色成员不影响在途的单）"""
    return [(int(u), n) for u, n in (_json(inst.variables).get('queue') or {}).get(node_id) or []]


def _next_in_queue(inst: WfInstance, task: WfTask) -> tuple[int, str] | None:
    """依次审批：这个人之后轮到谁。转交 / 改办理人出来的待办按**原办理人**在队列里的位置算"""
    queue = _queue(inst, task.node_id)
    ids = [u for u, _ in queue]
    me = task.origin_assignee_id or task.assignee_id
    if me not in ids:
        return None
    i = ids.index(me)
    return queue[i + 1] if i + 1 < len(queue) else None


async def _on_node(db: AsyncSession, inst: WfInstance, task: WfTask) -> set[int]:
    """这一步（同一轮）里已经有份的人：还在办的、已经同意过的、依次审批还没轮到的。

    转交 / 改办理人不能交给他们：会签就成了一个人投两票（A 同意 → B 转给 A → A 再同意，
    三人会签只有两人表态）；依次审批里交给排在后面的人，他就要审两次。
    🔴 只数**同一轮**（`batch`）：退回之后重走这个节点，上一轮同意过的人这一轮还没表态
    """
    ids = set(
        (
            await db.scalars(
                select(WfTask.assignee_id).where(
                    WfTask.instance_id == inst.id,
                    WfTask.node_id == task.node_id,
                    WfTask.batch == task.batch,
                    (WfTask.status == TaskStatus.pending) | (WfTask.decision == 'approve'),
                )
            )
        ).all()
    )
    return ids | {u for u, _ in _queue(inst, task.node_id)}


def _root_id(inst: WfInstance) -> str:
    return _json(inst.model_snapshot)['root']['id']


# ── 加签组 ───────────────────────────────────────────────────────────────────
#
# 加签拉进来的人是一「组」，存在 `inst.variables['signs']`：
# `{id, node, batch, owner: [id, 名字], owner_origin, kind: before|after, members: [id…]}`。
# 一条待办属于哪个组：同节点、同轮次、它的**原办理人**在 members 里（组员转交出去的待办仍然算组员的）。


def _signs(inst: WfInstance) -> list[dict[str, Any]]:
    return list(_json(inst.variables).get('signs') or [])


def _sign_group(inst: WfInstance, task: WfTask) -> dict[str, Any] | None:
    who = task.origin_assignee_id or task.assignee_id
    for g in _signs(inst):
        if g['node'] == task.node_id and g['batch'] == task.batch and who in g['members']:
            return g
    return None


def _drop_signs(inst: WfInstance, node_id: str) -> None:
    """离开这个节点（往下走 / 被退回 / 结束）时，这个节点上没收尾的加签组一并作废"""
    signs = _signs(inst)
    if any(g['node'] == node_id for g in signs):
        _set_var(inst, 'signs', [g for g in signs if g['node'] != node_id])


# ── 退回后重新提交：直达退回的那一步 ─────────────────────────────────────────


def _on_path(nodes: dict[str, Any], start: dict[str, Any] | None, target_id: str, cond_vars: dict[str, Any]) -> bool:
    """从 `start` 按当前表单沿树走，会不会经过 `target_id`（和推进同一个 `pick_branch`）"""
    node = start
    for _ in range(200):
        if node is None:
            return False
        if node['id'] == target_id:
            return True
        if node['type'] == 'condition':
            node = pick_branch(node, cond_vars).get('child') or nodes[node['id']].after
            continue
        node = nodes[node['id']].after
    return False


def resume_jump(inst: WfInstance, nodes: dict[str, Any], from_node_id: str) -> dict[str, Any] | None:
    """`from_node_id` 这一步办完之后，是不是直接跳回当初退回它的那一步。

    退回时选了「直接回到我这一步」才有。🔴 跳之前确认那一步**按现在的表单仍在路上**：
    发起人改了金额，条件分支可能已经不走那一步了 —— 那就照常往下走，不能硬跳到一个不该经过的节点
    """
    resume = _json(inst.variables).get('resume')
    if not resume or resume.get('from') != from_node_id or resume.get('to') not in nodes:
        return None
    variables = _json(inst.variables)
    cond_vars = condition_variables({**(variables.get('biz') or {}), **_json(inst.form_data)}, inst.initiator_dept_id)
    if not _on_path(nodes, nodes[from_node_id].after, resume['to'], cond_vars):
        return None
    return nodes[resume['to']].node


async def _leave_node(ctx: _Ctx, inst: WfInstance, nodes: dict[str, Any], node_id: str) -> None:
    """一个节点办完，往下走：先看要不要直达退回的那一步，再清掉这个节点的加签组"""
    jump = resume_jump(inst, nodes, node_id)
    if (_json(inst.variables).get('resume') or {}).get('from') == node_id:
        _set_var(inst, 'resume', None)
    _drop_signs(inst, node_id)
    if jump is not None:
        _record(
            ctx,
            inst,
            'resume',
            actor_type=ActorType.system,
            node=jump,
            detail={'to': jump['id'], 'to_name': jump['name']},
        )
        await _advance(ctx, inst, jump)
    else:
        await _advance(ctx, inst, nodes[node_id].after)


# ── 拿回 ─────────────────────────────────────────────────────────────────────

#: 推进流程的动作。「最近一次推进」只看这些（催办 / 手动抄送不算）
_PROGRESS = (
    'start',
    'approve',
    'resubmit',
    'reject',
    'transfer',
    'reassign',
    'send_back',
    'take_back',
    'add_sign',
    # 超时自动处理也是推进：它之后「最近一次推进」就不是我了，不能再拿回
    'timeout_approve',
    'timeout_reject',
)


async def _take_back_ctx(db: AsyncSession, inst: WfInstance, actor_id: int) -> dict[str, Any] | None:
    """能不能拿回：这张单**最近一次推进**是我的同意，而且我同意之后新建的待办都还没人动。

    同意时把「同意之前的实例变量」和「这次新建了哪些待办」记在 `variables['undo']`。
    """
    undo = _json(inst.variables).get('undo')
    if not undo or undo.get('actor') != actor_id:
        return None
    last = await db.scalar(
        select(WfActionRecord.id)
        .where(
            WfActionRecord.instance_id == inst.id,
            WfActionRecord.result == 'ok',
            WfActionRecord.action.in_(_PROGRESS),
        )
        .order_by(WfActionRecord.created_time.desc(), WfActionRecord.id.desc())
        .limit(1)
    )
    if last != undo.get('rec'):
        return None
    spawned = undo.get('spawned') or []
    # 第二道：新建的待办有没有人动过。和「最近一次推进」那道互为兜底 —— 超时自动同意那条测试里
    # 去掉任何一道都还挡得住，两道一起去掉才红（`test_no_take_back_after_the_next_step_timed_out`）
    if spawned:
        untouched = await db.scalar(
            select(func.count()).select_from(WfTask).where(WfTask.id.in_(spawned), WfTask.status == TaskStatus.pending)
        )
        if untouched != len(spawned):
            return None
    elif inst.current_node_id != undo.get('node'):
        return None
    return undo


def _remember_undo(
    inst: WfInstance, rec: WfActionRecord, task: WfTask, prev_vars: dict[str, Any], actor_id: int, spawned: list[WfTask]
) -> None:
    prev = {k: v for k, v in prev_vars.items() if k != 'undo'}
    _set_var(
        inst,
        'undo',
        {
            'rec': rec.id,
            'actor': actor_id,
            'task': task.id,
            'node': task.node_id,
            'vars': prev,
            'spawned': [x.id for x in spawned],
        },
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
    # 业务审批的条件变量（handler snapshot 给的）在下面，表单字段在上面
    cond_vars = condition_variables({**(variables.get('biz') or {}), **form_data}, inst.initiator_dept_id)
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
                users = await assignee_rules.superusers(ctx.db, initiator_id=inst.initiator_id)
            if not users:
                reason = t('workflow.no_assignee_reject', node=node['name'])
                _record(ctx, inst, 'auto_reject', actor_type=ActorType.system, node=node, opinion=reason)
                await _finish(ctx, inst, InstanceStatus.rejected, reason)
                return

        # 轮次号 = 进入节点这一刻实例的 version（见 WfTask.batch）。一个事务里只会进入一个审批节点
        batch = inst.version
        first = users
        if ApprovalMode(node.get('mode') or ApprovalMode.any) == ApprovalMode.seq:
            # 依次审批：先只给第一个人建待办，顺序存进实例 —— 后面的人在前一个同意时才建
            queue = (_json(inst.variables).get('queue') or {}) | {node['id']: [[u, n] for u, n in users]}
            _set_var(inst, 'queue', queue)
            first = users[:1]
        for user in first:
            _new_task(ctx, inst, node['id'], node['name'], user, batch=batch)
        inst.current_node_id = node['id']
        ctx.push_todo([u for u, _ in first])
        return

    await _finish(ctx, inst, InstanceStatus.approved, None)


async def _add_cc(
    ctx: _Ctx, inst: WfInstance, users: list[tuple[int, str]], *, node_id: str | None, from_user_id: int | None
) -> list[tuple[int, str]]:
    """抄送并通知（avc-bp：抄送「此前 100% 静默」）。已经抄送过的人不重复"""
    if not users:
        return []
    # 🔴 先 flush：会话是 autoflush=False，同一个事务里前一个抄送节点刚加的行查不到 ——
    # 两个抄送节点抄同一个人时第二次照样插，提交时撞 uk_wf_cc_instance_user，这张单永远推不过去。
    # 平时碰巧没事，是因为发通知（notification_dao.create）顺手 flush 了；抄送的人正好是操作人
    # 自己时不发通知，就没人 flush
    await ctx.db.flush()
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


async def capabilities(  # ruff:ignore[complex-structure]
    db: AsyncSession, inst: WfInstance, actor: Actor
) -> tuple[list[Capability], WfTask | None]:
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

    at_start = inst.current_node_id == _root_id(inst)
    if my_task is not None and at_start:
        # 被退回到发起人：他的「同意」就是改完重新提交。不能驳回 / 转交自己的单
        caps.append(Capability(Action.approve, True))
    elif my_task is not None:
        caps += [Capability(Action.approve, True), Capability(Action.reject, True)]
        node = index_nodes(_json(inst.model_snapshot))[my_task.node_id].node
        configured = node.get('actions')
        allowed = get_handler(inst.biz_type).default_actions
        if configured is not None:
            allowed = allowed & {Action(a) for a in configured}
        # 加签进来的人只表态（同意 / 驳回 / 转交 / 抄送）：不能再加签、也不能把整张单退回去
        member = _sign_group(inst, my_task) is not None
        optional = (
            (Action.transfer, Action.cc) if member else (Action.transfer, Action.cc, Action.send_back, Action.add_sign)
        )
        caps += [Capability(a, True) for a in optional if a in allowed]
    elif not at_start and await _take_back_ctx(db, inst, actor.id) is not None:
        caps.append(Capability(Action.take_back, True))

    if inst.initiator_id == actor.id:
        caps.append(Capability(Action.withdraw, True))
        last = await db.scalar(
            select(func.max(WfActionRecord.created_time)).where(
                WfActionRecord.instance_id == inst.id,
                WfActionRecord.action == Action.remind,
                WfActionRecord.result == 'ok',
            )
        )
        if at_start:
            pass  # 单在自己手上，没人可催
        elif last is not None and timezone.now() - last < REMIND_INTERVAL:
            caps.append(Capability(Action.remind, False, t('error.workflow.remind_too_often')))
        else:
            caps.append(Capability(Action.remind, True))

    # avc-bp 的终止要求当前用户是办理人，管理员反而终止不了。这里改成管理员
    if actor.has(PERM_TERMINATE):
        caps.append(Capability(Action.terminate, True))
    # 改办理人：单在发起人手上（被退回）时没有可改的 —— 那一步只能是发起人自己
    if actor.has(PERM_REASSIGN) and not at_start:
        caps.append(Capability(Action.reassign, True))
    return caps, my_task


def _require(caps: list[Capability], action: Action, inst: WfInstance) -> None:
    for c in caps:
        if c.action == action:
            if not c.enabled:
                raise ActionRejected('action_disabled', instance_id=inst.id, reason=c.reason or '')
            return
    raise ActionRejected('action_not_allowed', instance_id=inst.id)


# ── 入口 ─────────────────────────────────────────────────────────────────────


async def _replay(db: AsyncSession, key: str, actor_id: int) -> dict[str, Any] | None:
    rec = await db.scalar(select(WfActionRecord).where(WfActionRecord.idempotency_key == key))
    if rec is None:
        return None
    # 键是别人用过的：不能把别人的结果当成「你这次已经成功了」还给你
    if rec.actor_id != actor_id:
        raise errors.ConflictError(msg=t('error.workflow.idempotency_key_invalid'))
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
                replay = await _replay(db, key, actor.id)
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
                replay = await _replay(db, key, actor.id)
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
    await _check_attachments(db, form_schema, {}, data, actor.id)

    clean_selected = _clean_selected(nodes, selected)

    snap = await handler.snapshot(db, biz_id, data)
    # 业务审批没有表单，条件变量来自 handler 的 snapshot；存进实例，推进 / 预告都要用
    biz_vars = snap.variables if definition.biz_type != FORM_BIZ_TYPE else {}

    # 「发起人自选」只要求**会走到的**节点选人：按这次填的内容试算一遍，和预告同一套规则。
    # 原来是所有自选节点都必须选 —— 走不到的那条分支也要挑一个审批人，否则提交不了
    steps = await simulate(
        db,
        model,
        form_data={**biz_vars, **data},
        initiator_id=actor.id,
        initiator_dept_id=actor.dept_id,
        selected=clean_selected,
        start_from=nodes[model['root']['id']].after,
    )
    for st in steps:
        if st['outcome'] == 'pick':
            raise errors.RequestError(msg=t('error.workflow.selected_required', node=st['name']))
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
        summary=snap.summary or _summary(form_schema, data, model),
        initiator_id=actor.id,
        initiator_dept_id=actor.dept_id,
        status=InstanceStatus.running,
        current_node_id=None,
        # 原样拷贝，不经过任何解析 —— 见 engine/schema.py 头注释
        form_snapshot=version.form_json,
        model_snapshot=version.model_json,
        form_data=json.dumps(data, ensure_ascii=False),
        variables=json.dumps({'selected': clean_selected, 'biz': biz_vars}, ensure_ascii=False),
        active_key=active_key,
    )
    db.add(inst)
    await db.flush()
    await _sync_file_relations(db, inst, form_schema, data, actor.id)
    _record(ctx, inst, 'start', key=key, actor_id=actor.id, actor_name=actor.nickname)
    await _advance(ctx, inst, nodes[model['root']['id']].after)
    # 只插一行 pending，模型调用在事务提交之后的 Celery 里（#111 不变式 1）
    await ai_review_service.queue_in_tx(ctx, inst)
    return inst


def _clean_selected(nodes: dict[str, Any], selected: dict[str, Any] | None) -> dict[str, list[str]]:
    """自选审批人：只收「这个节点确实是 select_on_start」的，其余的丢掉；ID 必须是合法的字符串"""
    out: dict[str, list[str]] = {}
    for nid, ids in (selected or {}).items():
        ref = nodes.get(nid)
        if ref and ref.node['type'] == 'approval' and (ref.node.get('assignee') or {}).get('kind') == 'select_on_start':
            if not isinstance(ids, list) or not all(isinstance(x, str) and is_bigint_id(x) for x in ids):
                raise errors.RequestError(msg=t('error.workflow.selected_invalid'))
            out[nid] = ids
    return out


async def _check_picks(
    db: AsyncSession,
    inst: WfInstance,
    model: dict[str, Any],
    selected: dict[str, list[str]],
    start_from: dict[str, Any] | None,
) -> None:
    """按现在的表单试算一遍：路上的「发起人自选」节点都得选了人（发起和重新提交同一条规则）"""
    biz = _json(inst.variables).get('biz') or {}
    steps = await simulate(
        db,
        model,
        form_data={**biz, **_json(inst.form_data)},
        initiator_id=inst.initiator_id,
        initiator_dept_id=inst.initiator_dept_id,
        selected=selected,
        start_from=start_from,
    )
    for st in steps:
        if st['outcome'] == 'pick':
            raise errors.RequestError(msg=t('error.workflow.selected_required', node=st['name']))


#: 审批单在 `sys_file_relation` 里的业务类型
FILE_TARGET = 'WF_INSTANCE'


async def _sync_file_relations(
    db: AsyncSession, inst: WfInstance, form_schema: dict[str, Any], data: dict[str, Any], actor_id: int
) -> None:
    """表单里的附件同步一份到 `sys_file_relation`（发起 / 审批改表单之后）。

    下载权限要回答「这个文件挂在哪张审批单上」：原来按 `form_data LIKE '%"<id>"%'` 找，是全表扫
    TEXT 列。记一份关联之后按 `file_id` 走索引。⚠️ 关联只回答「在哪张单上」，看不看得见那个字段
    仍由 `query_service._workflow_file_access` 按查看人判
    """
    from backend.app.admin.model import FileRelation

    want = {
        int(x) for f in form_schema.get('fields') or [] if f['type'] == 'attachment' for x in data.get(f['id']) or []
    }
    rows = (
        await db.scalars(
            select(FileRelation).where(
                FileRelation.target_type == FILE_TARGET, FileRelation.target_id == inst.id, FileRelation.deleted == 0
            )
        )
    ).all()
    have = {r.file_id: r for r in rows}
    for fid in want - have.keys():
        db.add(FileRelation(file_id=fid, target_type=FILE_TARGET, target_id=inst.id, sort=0, created_by=actor_id))
    gone = [r.id for fid, r in have.items() if fid not in want]
    if gone:
        await db.execute(delete(FileRelation).where(FileRelation.id.in_(gone)))


async def _check_attachments(
    db: AsyncSession, form_schema: dict[str, Any], before: dict[str, Any], after: dict[str, Any], actor_id: int
) -> None:
    """新挂上的附件必须是**这个人自己上传的**文件。

    🔴 不校验的话，表单里填一个别人私有文件的 ID，审批单就成了一条读取通道：
    详情接口会把它当附件列出来，所有参与人都能下载。已经在单子上的（前面的人挂的）不算「新挂」，
    不受这条限制 —— 审批人改的是自己那几个字段，别人挂的附件他动不了也不该被挡。
    """
    from backend.app.admin.model import File

    new_ids: set[int] = set()
    for f in form_schema.get('fields') or []:
        if f['type'] != 'attachment':
            continue
        old = set(before.get(f['id']) or [])
        new_ids |= {int(x) for x in after.get(f['id']) or [] if x not in old}
    if not new_ids:
        return
    owned = set(
        (
            await db.scalars(
                select(File.id).where(
                    File.id.in_(new_ids), File.created_by == actor_id, File.is_public == false(), File.deleted == 0
                )
            )
        ).all()
    )
    if owned != new_ids:
        raise errors.RequestError(msg=t('error.workflow.attachment_not_yours'))


def _summary(form_schema: dict[str, Any], data: dict[str, Any], model: dict[str, Any]) -> str | None:
    """前三个有值的简单字段拼成一行，审批中心列表 / 抄送通知 / 详情头部里显示。

    🔴 **只用对所有人都可见的字段**：摘要在发起时就拼好存下，之后原样出现在待办、抄送列表和
    通知正文里，**不经过**按查看人裁字段那一步。原来取的是前三个有值的字段 ——
    「薪资」在审批节点上是 hidden，抄送人照样在列表里看到「薪资：50000」（独立审查发现）。
    所以凡是在任何一个节点（含开始节点）上被设成 hidden 的字段，一律不进摘要。
    """
    hidden: set[str] = {k for k, v in (model['root'].get('fieldPerms') or {}).items() if v == 'hidden'}
    for ref in index_nodes(model).values():
        hidden |= {k for k, v in (ref.node.get('fieldPerms') or {}).items() if v == 'hidden'}
    parts = []
    for f in form_schema.get('fields') or []:
        v = data.get(f['id'])
        if f['id'] in hidden:
            continue
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
    urgent: bool = False,
    keep_draft: bool = False,
) -> dict[str, Any]:
    async def body(ctx: _Ctx) -> int:
        d, v = await published_definition(ctx.db, code)
        if d.biz_type != FORM_BIZ_TYPE:
            raise errors.RequestError(msg=t('error.workflow.not_form_definition'))
        inst = await start_in_tx(
            ctx, definition=d, version=v, actor=actor, form_data=form_data, selected=selected, biz_id=None, key=key
        )
        inst.urgent = urgent
        # 提交成功 = 草稿用完了。和发起同一个事务：发起失败草稿还在。
        # 「重新发起」（内容来自旧单）不动草稿：那份草稿是另一张没写完的单
        if not keep_draft:
            await ctx.db.execute(delete(WfDraft).where(WfDraft.user_id == actor.id, WfDraft.code == code))
        return inst.id

    return await execute(db, key=key, action='start', actor=actor, body=body)


async def start_for_biz(
    db: AsyncSession, *, code: str, biz_id: int, actor: Actor
) -> tuple[WfInstance, list[Callable[[], Awaitable[None]]]]:
    """业务审批：在业务**自己的事务**里调。返回实例和提交后要跑的推送（业务提交后调 `run_effects`）。

    条件变量由 handler 的 `snapshot().variables` 给 —— 原来这里另收一个 `variables` 参数当表单数据，
    结果被表单校验整个滤掉（业务流程的表单是空的），条件分支永远走兜底（独立审查发现）。
    """
    d, v = await published_definition(db, code)
    ctx = _Ctx(db=db, actor_id=actor.id)
    inst = await start_in_tx(
        ctx, definition=d, version=v, actor=actor, form_data={}, selected={}, biz_id=biz_id, key=None
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
    target_node_id: str | None = None,
    task_id: int | None = None,
    resume: bool = False,
    sign_mode: str | None = None,
    selected: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # 接口层的 SchemaBase 会把枚举还原成 str —— 这里统一回枚举，后面 match / .value 都按枚举写
    action = Action(action)
    opinion = (opinion or '').strip() or None

    async def body(ctx: _Ctx) -> int:  # ruff:ignore[complex-structure]
        inst = await _load_instance(ctx.db, instance_id)
        # 🔴 先判「看不看得见」，再判状态、再认领：和这张单无关的人一律 404、不落记录、不锁行。
        # 原来先认领再判能力 —— 任何登录用户拿一个 ID 就能锁一下这张单、写一条 rejected 记录，
        # 而 404 / 409 的区别等于告诉他「这个 ID 存在、结没结束」（详情接口那边看不见是 404）
        if not await _can_view(ctx.db, inst, actor):
            raise errors.NotFoundError(msg=t('error.workflow.instance_not_found'))
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
            case Action.approve if my_task is not None and my_task.node_id == _root_id(inst):
                # 被退回之后发起人改完重新提交：按开始节点的字段权限收改动，然后从头往下走
                root = nodes[my_task.node_id].node
                detail = await _apply_form_patch(ctx.db, inst, root, form_patch or {}, actor.id)
                await _close_task(ctx.db, my_task, TaskStatus.done, 'resubmit', opinion)
                _record(
                    ctx,
                    inst,
                    'resubmit',
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    opinion=opinion,
                    detail=detail,
                )
                form_schema, model = _json(inst.form_snapshot), _json(inst.model_snapshot)
                inst.summary = _summary(form_schema, _json(inst.form_data), model)
                _set_var(inst, 'undo', None)
                # 🔴 改了表单，路可能变了：新路上的「发起人自选」节点要有人。不查的话那个节点取人为空，
                # 按 onEmpty（默认驳回）当场就被自动驳回 —— 而重新提交的正是发起人自己，他收不到通知
                picks = {**(_json(inst.variables).get('selected') or {}), **_clean_selected(nodes, selected)}
                _set_var(inst, 'selected', picks)
                await _check_picks(
                    ctx.db,
                    inst,
                    model,
                    picks,
                    resume_jump(inst, nodes, my_task.node_id) or nodes[my_task.node_id].after,
                )
                await _leave_node(ctx, inst, nodes, my_task.node_id)
                # 改过的表单重新预审；旧结论随之作废（详情只看最新一次）
                await ai_review_service.queue_in_tx(ctx, inst)
                ctx.push_todo([actor.id])

            case Action.approve:
                assert my_task is not None
                prev_vars = _json(inst.variables)
                node = nodes[my_task.node_id].node
                # 不传改动也要走一遍：这个节点上「可编辑 + 必填」的字段没填，不许同意
                detail = await _apply_form_patch(ctx.db, inst, node, form_patch or {}, actor.id)
                await _close_task(ctx.db, my_task, TaskStatus.done, 'approve', opinion)
                rec = _record(
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
                ctx.spawned.clear()
                group = _sign_group(inst, my_task)
                if group is not None:
                    await _sign_member_done(ctx, inst, nodes, node, my_task, group)
                else:
                    await _after_approve(ctx, inst, nodes, node, my_task)
                ctx.push_todo([actor.id])
                await ctx.db.flush()  # 新待办 / 这条记录要有 ID，拿回靠它们
                _remember_undo(inst, rec, my_task, prev_vars, actor.id, ctx.spawned)

            case Action.take_back:
                undo = await _take_back_ctx(ctx.db, inst, actor.id)
                if undo is None:
                    raise ActionRejected('action_not_allowed', instance_id=inst.id)
                for tid in undo.get('spawned') or []:
                    spawned = await ctx.db.get(WfTask, tid, populate_existing=True)
                    if spawned is not None and spawned.status == TaskStatus.pending:
                        await _close_task(ctx.db, spawned, TaskStatus.canceled, None, None)
                        ctx.push_todo([spawned.assignee_id])
                old = await ctx.db.get(WfTask, undo['task'], populate_existing=True)
                assert old is not None
                # 原来那条「已同意 / 已加签」改成「已拿回」：进度里不能还显示他同意过
                old.decision = 'take_back'
                # 实例变量（依次审批队列、加签组、直达标记）回到同意之前
                inst.variables = json.dumps(undo['vars'], ensure_ascii=False)
                _new_task(
                    ctx,
                    inst,
                    old.node_id,
                    old.node_name,
                    (actor.id, old.assignee_name),
                    batch=old.batch,
                    origin=old.origin_assignee_id,
                )
                inst.current_node_id = old.node_id
                _record(ctx, inst, action, key=key, actor_id=actor.id, actor_name=actor.nickname, task=old)
                ctx.push_todo([actor.id])

            case Action.add_sign:
                assert my_task is not None
                if sign_mode not in ('before', 'after'):
                    raise errors.RequestError(msg=t('error.workflow.sign_mode_invalid'))
                users = await _sign_targets(ctx, inst, my_task, target_user_ids, actor.id)
                prev_vars = _json(inst.variables)
                ctx.spawned.clear()
                node = nodes[my_task.node_id].node
                detail: dict[str, Any] = {'mode': sign_mode}
                if sign_mode == 'after':
                    # 在我之后：我这一票是同意（要过本节点的表单校验），他们都同意之后才往下走
                    detail |= await _apply_form_patch(ctx.db, inst, node, form_patch or {}, actor.id)
                    await _close_task(ctx.db, my_task, TaskStatus.done, 'approve', opinion)
                else:
                    await _close_task(ctx.db, my_task, TaskStatus.done, 'add_sign', opinion)
                rec = _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    target=users,
                    opinion=opinion,
                    detail=detail,
                )
                group = {
                    'id': uuid.uuid4().hex[:8],
                    'node': my_task.node_id,
                    'batch': my_task.batch,
                    'owner': [actor.id, my_task.assignee_name],
                    'owner_origin': my_task.origin_assignee_id,
                    'kind': sign_mode,
                    'members': [u for u, _ in users],
                }
                _set_var(inst, 'signs', [*_signs(inst), group])
                for user in users:
                    _new_task(ctx, inst, my_task.node_id, my_task.node_name, user, batch=my_task.batch)
                if sign_mode == 'after' and ApprovalMode(node.get('mode') or ApprovalMode.any) == ApprovalMode.any:
                    # 或签：我已经同意了，同一步的其他人不用再办（加签的人除外）
                    for other in await _pending_tasks(ctx.db, inst.id, my_task.node_id):
                        if _sign_group(inst, other) is None:
                            await _close_task(ctx.db, other, TaskStatus.canceled, None, None)
                            ctx.push_todo([other.assignee_id])
                ctx.push_todo([actor.id, *(u for u, _ in users)])
                await ctx.db.flush()
                _remember_undo(inst, rec, my_task, prev_vars, actor.id, ctx.spawned)

            case Action.send_back:
                assert my_task is not None
                if not opinion:
                    raise errors.RequestError(msg=t('error.workflow.opinion_required'))
                targets = {x['node_id']: x['name'] for x in await send_back_targets(ctx.db, inst)}
                if target_node_id not in targets:
                    raise ActionRejected('send_back_target_invalid', instance_id=inst.id)
                await _close_task(ctx.db, my_task, TaskStatus.done, 'send_back', opinion)
                for other in await _pending_tasks(ctx.db, inst.id):
                    await _close_task(ctx.db, other, TaskStatus.canceled, None, None)
                    ctx.push_todo([other.assignee_id])
                _drop_signs(inst, my_task.node_id)
                # 「重新提交 / 那一步办完之后直接回到我这一步」：记下来，`_leave_node` 用
                _set_var(inst, 'resume', {'from': target_node_id, 'to': my_task.node_id} if resume else None)
                _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=my_task,
                    opinion=opinion,
                    detail={'to': target_node_id, 'to_name': targets[target_node_id], 'resume': resume},
                )
                ctx.push_todo([actor.id])
                if target_node_id == _root_id(inst):
                    # 回到发起人手里：给他建一条待办（改完重新提交），并且**发通知** ——
                    # 审批人收待办只推角标，发起人不一样，他并不在等这张单回来
                    names = await _user_names(ctx.db, [inst.initiator_id])
                    _new_task(
                        ctx,
                        inst,
                        target_node_id,
                        t('workflow.resubmit_node'),
                        (inst.initiator_id, names.get(inst.initiator_id, '')),
                        batch=inst.version,
                    )
                    inst.current_node_id = target_node_id
                    ctx.push_todo([inst.initiator_id])
                    await ctx.notify(
                        [inst.initiator_id],
                        t('workflow.notify.sent_back_title', title=inst.title),
                        t('workflow.notify.sent_back_content', user=actor.nickname, opinion=opinion),
                        detail_link(inst.id),
                    )
                else:
                    # 重新进入那个节点：审批人按规则**重新解析**（和第一次进入同一套逻辑）
                    await _advance(ctx, inst, nodes[target_node_id].node)

            case Action.reassign:
                task = next(
                    (x for x in await _pending_tasks(ctx.db, inst.id, inst.current_node_id) if x.id == task_id), None
                )
                if task is None:
                    raise ActionRejected('task_not_pending', instance_id=inst.id)
                target_id, target_name, users = await _handover_target(ctx, inst, task, target_user_ids)
                await _close_task(ctx.db, task, TaskStatus.transferred, None, None)
                _new_task(
                    ctx,
                    inst,
                    task.node_id,
                    task.node_name,
                    (target_id, target_name),
                    batch=task.batch,
                    origin=task.origin_assignee_id or task.assignee_id,
                )
                _record(
                    ctx,
                    inst,
                    action,
                    key=key,
                    actor_id=actor.id,
                    actor_name=actor.nickname,
                    task=task,
                    target=users,
                    opinion=opinion,
                    detail={'from': task.assignee_name},
                )
                ctx.push_todo([task.assignee_id, target_id])

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
                target_id, target_name, users = await _handover_target(ctx, inst, my_task, target_user_ids)
                await _close_task(ctx.db, my_task, TaskStatus.transferred, None, opinion)
                _new_task(
                    ctx,
                    inst,
                    my_task.node_id,
                    my_task.node_name,
                    (target_id, target_name),
                    batch=my_task.batch,
                    origin=my_task.origin_assignee_id or actor.id,
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


async def _after_approve(ctx: _Ctx, inst: WfInstance, nodes: dict[str, Any], node: dict[str, Any], task: Any) -> None:
    """一票同意之后这一步怎么走：依次审批轮到下一个 / 或签结束 / 会签等其他人。

    `task` 只用到 `node_id` / `batch` / `origin_assignee_id` / `assignee_id` —— 「在我之后」加签收尾时
    传的是加签发起人的替身（他的那一票当时就投了，现在才轮到它生效）
    """
    rest = await _pending_tasks(ctx.db, inst.id, task.node_id)
    mode = ApprovalMode(node.get('mode') or ApprovalMode.any)
    nxt = _next_in_queue(inst, task) if mode == ApprovalMode.seq else None
    if nxt is not None:
        # 依次审批：轮到下一个人，还在这一步、同一轮
        _new_task(ctx, inst, task.node_id, node['name'], nxt, batch=task.batch)
        ctx.push_todo([nxt[0]])
    elif mode == ApprovalMode.any or not rest:
        for other in rest:
            await _close_task(ctx.db, other, TaskStatus.canceled, None, None)
            ctx.push_todo([other.assignee_id])
        await _leave_node(ctx, inst, nodes, task.node_id)


async def _sign_member_done(
    ctx: _Ctx, inst: WfInstance, nodes: dict[str, Any], node: dict[str, Any], task: WfTask, group: dict[str, Any]
) -> None:
    """加签组里的一个人同意了。组里还有人没办就等；都办完了：

    - 在我之前：待办回到加签发起人手上
    - 在我之后：发起人那一票当时就投了，现在按它刚生效来走（依次审批的下一个 / 或签结束 / 会签再数一遍）

    🔴 组员的同意**本身不算这一步的一票**：或签节点上组员一同意就往下走的话，加签发起人还没表态单子就过了
    """
    for other in await _pending_tasks(ctx.db, inst.id, task.node_id):
        g = _sign_group(inst, other)
        if g is not None and g['id'] == group['id']:
            return
    _set_var(inst, 'signs', [g for g in _signs(inst) if g['id'] != group['id']])
    owner = (int(group['owner'][0]), group['owner'][1])
    if group['kind'] == 'before':
        _new_task(ctx, inst, task.node_id, task.node_name, owner, batch=task.batch, origin=group['owner_origin'])
        ctx.push_todo([owner[0]])
        return
    proxy = SimpleNamespace(
        node_id=task.node_id, batch=task.batch, origin_assignee_id=group['owner_origin'], assignee_id=owner[0]
    )
    await _after_approve(ctx, inst, nodes, node, proxy)


async def _sign_targets(
    ctx: _Ctx, inst: WfInstance, task: WfTask, target_user_ids: list[int] | None, actor_id: int
) -> list[tuple[int, str]]:
    """加签的人：1–10 个、在职、不是发起人、不是这一步里已经有份的人（同转交那一条）"""
    ids = list(dict.fromkeys(target_user_ids or []))
    if not ids or len(ids) > 10:
        raise errors.RequestError(msg=t('error.workflow.sign_users_invalid'))
    users = await assignee_rules.users_by_ids(ctx.db, ids)
    if len(users) != len(ids):
        raise errors.RequestError(msg=t('error.workflow.user_not_found'))
    on = await _on_node(ctx.db, inst, task)
    for uid, _ in users:
        if uid == inst.initiator_id:
            raise ActionRejected('transfer_to_initiator', instance_id=inst.id)
        if uid == actor_id or uid in on:
            raise ActionRejected('transfer_to_existing', instance_id=inst.id)
    return users


async def _can_view(db: AsyncSession, inst: WfInstance, actor: Actor) -> bool:
    """能不能对这张单做任何事：发起人 / 当过办理人 / 被抄送 / 有实例管理权限（同详情接口的 404 口径）"""
    if inst.initiator_id == actor.id or any(actor.has(p) for p in (PERM_MONITOR, PERM_TERMINATE, PERM_REASSIGN)):
        return True
    involved = await db.scalar(
        select(func.count()).select_from(WfTask).where(WfTask.instance_id == inst.id, WfTask.assignee_id == actor.id)
    )
    if involved:
        return True
    return bool(
        await db.scalar(
            select(func.count()).select_from(WfCc).where(WfCc.instance_id == inst.id, WfCc.user_id == actor.id)
        )
    )


async def _handover_target(
    ctx: _Ctx, inst: WfInstance, task: WfTask, target_user_ids: list[int] | None
) -> tuple[int, str, list[tuple[int, str]]]:
    """转交 / 改办理人的目标人校验（两个动作同一套规则）"""
    if not target_user_ids or len(target_user_ids) != 1:
        raise errors.RequestError(msg=t('error.workflow.transfer_one'))
    users = await assignee_rules.users_by_ids(ctx.db, target_user_ids)
    if not users:
        raise errors.RequestError(msg=t('error.workflow.user_not_found'))
    target_id, target_name = users[0]
    if target_id == inst.initiator_id:
        raise ActionRejected('transfer_to_initiator', instance_id=inst.id)
    if target_id in await _on_node(ctx.db, inst, task):
        raise ActionRejected('transfer_to_existing', instance_id=inst.id)
    return target_id, target_name, users


async def _user_names(db: AsyncSession, ids: list[int]) -> dict[int, str]:
    """姓名快照。不过滤停用 —— 发起人账号停用了，他那条待办也得有个名字"""
    from backend.app.admin.model import User

    return dict((await db.execute(select(User.id, User.nickname).where(User.id.in_(ids)))).all())


async def send_back_targets(db: AsyncSession, inst: WfInstance) -> list[dict[str, str]]:
    """能退回到哪：发起人 + 当前节点**之前**、这张单真的经过（有人同意过）的审批节点。

    「之前」按**现在的表单**沿树走一遍算（和推进同一个 `pick_branch`）：走到当前节点为止，
    路上的审批节点才是「已经走过的」。只看历史记录不行 —— 退回过一次之后，历史里会有
    排在当前节点后面的节点（A → B → C，C 退回到 A，现在在 B：C 不能当退回目标）。
    """
    model = _json(inst.model_snapshot)
    nodes = index_nodes(model)
    root = model['root']
    variables = _json(inst.variables)
    cond_vars = condition_variables({**(variables.get('biz') or {}), **_json(inst.form_data)}, inst.initiator_dept_id)
    approved = set(
        (
            await db.scalars(select(WfTask.node_id).where(WfTask.instance_id == inst.id, WfTask.decision == 'approve'))
        ).all()
    )
    before: list[dict[str, str]] = []
    node = nodes[root['id']].after
    reached = False
    for _ in range(200):  # 防御：手改过的快照里有环
        if node is None:
            break
        if node['id'] == inst.current_node_id:
            reached = True
            break
        if node['type'] == 'condition':
            node = pick_branch(node, cond_vars).get('child') or nodes[node['id']].after
            continue
        if node['type'] == 'approval' and node['id'] in approved:
            before.append({'node_id': node['id'], 'name': node['name']})
        node = nodes[node['id']].after
    out = [{'node_id': root['id'], 'name': t('workflow.initiator')}]
    return out + before if reached else out


async def _apply_form_patch(
    db: AsyncSession, inst: WfInstance, node: dict[str, Any], patch: dict[str, Any], actor_id: int
) -> dict[str, Any]:
    """审批时改表单：🔴 **只收这个节点上 editable 的字段**，其余的直接拒绝（不是静默丢掉 ——
    静默丢掉的话前端以为改成功了）。

    校验只针对本节点可编辑的字段（含必填）：别的字段是发起人 / 前面的节点填的，这里没有
    改它们的权利，也就不该因为它们挡住这一步。前后差异记进轨迹。
    """
    form_schema = _json(inst.form_snapshot)
    # 开始节点（被退回后发起人重新提交）默认可填；审批节点默认只读
    allowed = (
        start_editable_fields(form_schema, node) if node['type'] == 'start' else editable_fields(form_schema, node)
    )
    illegal = set(patch) - allowed
    if illegal:
        raise ActionRejected('field_not_editable', instance_id=inst.id, fields='、'.join(sorted(illegal)))
    if not allowed:
        return {}
    before = _json(inst.form_data)
    try:
        data = validate_form_data(form_schema, {**before, **patch}, only=allowed, base=before)
    except FormDataError as e:
        raise errors.RequestError(msg=t('error.workflow.form_invalid', detail=str(e)), data=e.errors) from e
    await _check_attachments(db, form_schema, before, data, actor_id)
    changes = {k: {'from': before.get(k), 'to': data.get(k)} for k in allowed if before.get(k) != data.get(k)}
    inst.form_data = json.dumps(data, ensure_ascii=False)
    await _sync_file_relations(db, inst, form_schema, data, actor_id)
    return {'form_changes': changes} if changes else {}


# ── 离职交接 ─────────────────────────────────────────────────────────────────


async def _transferable(db: AsyncSession, user_id: int | None = None) -> list[tuple[int, int, str, int]]:
    """在办、可以交给别人的待办：`(待办 ID, 实例 ID, 标题, 办理人)`。

    不含「被退回、等发起人自己重新提交」的那种 —— 那是他自己的单，交给别人等于替他提交
    """
    stmt = (
        select(
            WfTask.id,
            WfTask.instance_id,
            WfInstance.title,
            WfTask.assignee_id,
            WfTask.node_id,
            WfInstance.model_snapshot,
        )
        .join(WfInstance, WfInstance.id == WfTask.instance_id)
        .where(WfTask.status == TaskStatus.pending, WfInstance.status == InstanceStatus.running)
        .order_by(WfTask.id)
    )
    if user_id is not None:
        stmt = stmt.where(WfTask.assignee_id == user_id)
    rows = (await db.execute(stmt)).all()
    return [
        (tid, iid, title, uid) for tid, iid, title, uid, nid, model in rows if nid != json.loads(model)['root']['id']
    ]


async def handover_tasks(db: AsyncSession, user_id: int) -> list[tuple[int, int, str]]:
    return [(tid, iid, title) for tid, iid, title, _ in await _transferable(db, user_id)]


async def handover_holders(db: AsyncSession) -> list[dict[str, Any]]:
    """手上有在办待办的人，按条数从多到少。

    🔴 **要包含停用 / 删除的账号**：离职的人账号通常已经停用了，而选人控件只列在职的人 ——
    用选人控件选「交出待办的人」，恰恰选不到最需要交接的那一个
    """
    from backend.app.admin.model import User

    counts: dict[int, int] = {}
    for *_, uid in await _transferable(db):
        counts[uid] = counts.get(uid, 0) + 1
    if not counts:
        return []
    users = {
        u: (n, s == 1 and d == 0)
        for u, n, s, d in (
            await db.execute(select(User.id, User.nickname, User.status, User.deleted).where(User.id.in_(counts)))
        ).all()
    }
    out = [
        {
            'user_id': uid,
            'name': users.get(uid, (str(uid), False))[0],
            'active': users.get(uid, ('', False))[1],
            'count': n,
        }
        for uid, n in counts.items()
    ]
    return sorted(out, key=lambda x: (-x['count'], x['name']))


async def handover(db: AsyncSession, *, from_user_id: int, to_user_id: int, actor: Actor, key: str) -> dict[str, Any]:
    """逐条改办理人。**每条一个事务**：一张单交不过去（接手的人就是发起人 / 已经在这一步里）
    不影响其他单，结果里逐条列出没交过去的和原因。

    幂等键按「这次交接的键 + 待办 ID」派生：重复点一次，已经交过的那些重放、不会再交一遍
    """
    import hashlib

    if from_user_id == to_user_id:
        raise errors.RequestError(msg=t('error.workflow.handover_same_user'))
    moved = 0
    skipped: list[dict[str, Any]] = []
    for task_id, instance_id, title in await handover_tasks(db, from_user_id):
        sub_key = 'ho:' + hashlib.sha256(f'{key}:{task_id}'.encode()).hexdigest()[:48]
        try:
            await act(
                db,
                instance_id=instance_id,
                action=Action.reassign,
                actor=actor,
                key=sub_key,
                opinion=t('workflow.handover_opinion'),
                target_user_ids=[to_user_id],
                task_id=task_id,
            )
            moved += 1
        except (errors.BaseExceptionError, ActionRejected) as e:
            skipped.append({'instance_id': instance_id, 'title': title, 'reason': e.msg})
    return {'moved': moved, 'skipped': skipped}


# ── 超时 ─────────────────────────────────────────────────────────────────────
#
# 由 `timeout_service.handle_timeouts` 每 5 分钟扫一遍调到这里。时钟从**待办到这个人手上**那一刻算
# （`wf_task.created_time`）：依次审批轮到下一个人、转交出来的待办都重新计时。
# 🔴 自动同意 / 驳回和人点按钮走同一条路：先认领实例再动待办，认领失败（有人正在办）就留给下一轮。
# 不计工作日：「24 小时」就是自然时间的 24 小时。

#: 提醒最多几次：到点提醒一次，之后每隔同样的时长再提醒，第 3 次之后不再打扰
REMIND_MAX = 3


def timeout_of(model: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    ref = index_nodes(model).get(node_id)
    if ref is None or ref.node['type'] != 'approval':
        return None
    return ref.node.get('timeout') or None


def due_time(task: WfTask, model: dict[str, Any]) -> datetime | None:
    """这条待办什么时候算超时（没配超时 = None）。详情接口拿它给前端显示「X 点自动通过」"""
    cfg = timeout_of(model, task.node_id)
    if not cfg:
        return None
    return task.created_time + timedelta(hours=cfg['hours'])


async def apply_timeout(db: AsyncSession, instance_id: int, task_id: int, now: datetime) -> str | None:
    """处理一条到点的待办（`timeout_service` 逐条调）。条件在事务里重新判，返回做了什么（None = 不用处理）"""
    ctx = _Ctx(db=db, actor_id=None)
    async with db.begin():
        inst = await _load_instance(db, instance_id)
        task = await db.get(WfTask, task_id, populate_existing=True)
        if inst.status != InstanceStatus.running or task is None or task.status != TaskStatus.pending:
            return None
        model = json.loads(inst.model_snapshot)
        cfg = timeout_of(model, task.node_id)
        due = due_time(task, model)
        if not cfg or due is None or due > now:
            return None
        action = cfg['action']
        if action == 'approve' and not _approvable(inst, model, task):
            # 🔴 这一步有「可编辑 + 必填」的字段还空着：人点同意都过不去（`_apply_form_patch` 校验），
            # 超时也不能替他同意 —— 否则单子带着缺的数据「已通过」。退回成提醒，等人来填
            action = 'remind'

        if action == 'remind':
            # 第 k 个周期该提醒第 k 次；已经提醒够了就不再发。不改实例状态，不用认领
            periods = int((now - task.created_time) / timedelta(hours=cfg['hours']))
            sent = await db.scalar(
                select(func.count())
                .select_from(WfActionRecord)
                .where(WfActionRecord.task_id == task.id, WfActionRecord.action == 'timeout_remind')
            )
            if sent >= min(periods, REMIND_MAX):
                return None
            await ctx.notify(
                [task.assignee_id],
                t('workflow.notify.timeout_title', title=inst.title),
                t('workflow.notify.timeout_content', hours=cfg['hours']),
                detail_link(inst.id),
            )
            _record(ctx, inst, 'timeout_remind', actor_type=ActorType.system, task=task)
            result = 'remind'
        else:
            await _claim(db, inst)
            nodes = index_nodes(model)
            node = nodes[task.node_id].node
            if action == 'approve':
                opinion = t('workflow.timeout_approved', hours=cfg['hours'])
                await _close_task(db, task, TaskStatus.done, 'approve', opinion)
                _record(ctx, inst, 'timeout_approve', actor_type=ActorType.system, task=task, opinion=opinion)
                group = _sign_group(inst, task)
                if group is not None:
                    await _sign_member_done(ctx, inst, nodes, node, task, group)
                else:
                    await _after_approve(ctx, inst, nodes, node, task)
                ctx.push_todo([task.assignee_id])
                result = 'approve'
            else:
                opinion = t('workflow.timeout_rejected', hours=cfg['hours'])
                await _close_task(db, task, TaskStatus.done, 'reject', opinion)
                _record(ctx, inst, 'timeout_reject', actor_type=ActorType.system, task=task, opinion=opinion)
                ctx.push_todo([task.assignee_id])
                await _finish(ctx, inst, InstanceStatus.rejected, opinion)
                result = 'reject'
    await _run_effects(ctx.effects)
    return result


def _approvable(inst: WfInstance, model: dict[str, Any], task: WfTask) -> bool:
    """这条待办现在能不能「不改任何字段就同意」：本节点可编辑 + 必填的字段都有值"""
    node = index_nodes(model)[task.node_id].node
    form_schema = _json(inst.form_snapshot)
    data = _json(inst.form_data)
    try:
        validate_form_data(form_schema, data, only=editable_fields(form_schema, node), base=data)
    except FormDataError:
        return False
    return True
