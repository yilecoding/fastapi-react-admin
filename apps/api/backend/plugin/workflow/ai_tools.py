"""审批的 AI 工具（#111 第 4 条：在对话里审批）。

由 AI 插件的注册表自动发现（`load_builtin_tools` 扫各插件的 `ai_tools.py`）。放在审批插件这边而不是 AI 插件的
`tools/`：两个插件都能卸载，依赖方向要和预审一样是 workflow → ai。没装 AI 插件时这个文件不会被 import。

四条约束（#111 不变式 + 审批自己的规矩）：

- 🔴 **只读工具调审批中心同一套查询**（`query_service.todo` / `detail`），不自己写 SQL。隐藏字段除了详情还有五条路能漏
  （摘要 / 分支记录 / 预告 / 预告里的人名…，见本插件分册），自己写查询等于把那张表重新踩一遍
- 🔴 **写工具最终调 `runtime_service.act()`，执行人是用户本人**。能不能做由能力信封判 —— 和网页上点按钮同一个函数。
  所以这几个工具是 `self_authorized`：审批中心刻意不走 RBAC（非员工也要能审批），dispatcher 的 `is_staff` 那道闸不适用
- 🔴 **意见要用户原话**：预演核对它在用户这段对话里说过的话里（`ctx.user_said`）；确认卡片上原样显示将要提交的那一段。
  只靠描述不够 —— 描述里写了「不要替他拟」，Qwen3-VL 照样给驳回填了一句「用户未提供驳回理由」（真模型测试抓到的）
- 预演先查能力信封：「这张单现在不归你办」在弹确认卡片之前就说清楚，不让人点了确认才报错
"""

import uuid

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.plugin.ai.core.ports import RunContext
from backend.plugin.ai.core.registry import ai_tool
from backend.plugin.workflow.enums import Action
from backend.plugin.workflow.service import query_service, runtime_service
from backend.plugin.workflow.service.runtime_service import Actor

_ID_HINT = '审批单 ID 是字符串，先用 wf_todo_list 查到再传，不要自己编'
_ACTION_NAMES = {Action.approve: '同意', Action.reject: '驳回', Action.transfer: '转交'}


def _actor(ctx: RunContext) -> Actor:
    return Actor.from_user(ctx.user)


def _pk(instance_id: str) -> int:
    if not str(instance_id).isdigit():
        raise ValueError(f'审批单 ID 应该是一串数字：{instance_id}。{_ID_HINT}')
    return int(instance_id)


def _squash(text: str) -> str:
    return ''.join(text.split()).strip('。.！!')


#: 紧挨在前面就把意思反过来的字：用户说「我不同意」，「同意」也是它的一段
_NEGATIONS = frozenset('不没别未非勿莫')


def _quoted(words: str, message: str) -> bool:
    """`words` 是 `message` 里的一段，而且不是被否定的那一段（「我不同意」里的「同意」不算）"""
    start = message.find(words)
    while start >= 0:
        if start == 0 or message[start - 1] not in _NEGATIONS:
            return True
        start = message.find(words, start + 1)
    return False


def _own_words(ctx: RunContext, opinion: str | None) -> str | None:
    """意见必须是用户说过的话（允许是其中一段）。改写过的、编出来的，预演就拦下 —— 它会以用户本人的名义记进审批记录。

    🔴 两个边界：只剩标点的（「。」压完是空串，空串是任何字符串的子串）不算；被否定的那一段不算
    """
    if not opinion or not opinion.strip():
        return None
    said = ctx.user_said
    words = _squash(opinion)
    if said is not None and (not words or not any(_quoted(words, _squash(m)) for m in said)):
        raise ValueError(
            f'意见「{opinion.strip()}」不是用户的原话。请先问用户想写什么，再把他的原话原样传进来，不要替他拟或改写'
        )
    return opinion.strip()


def _when(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


#: 待办一次最多看多少张（按关键词在这里面筛）。审批人手上的待办通常就几张到几十张
_TODO_SCAN = 100


@ai_tool(
    name='wf_todo_list',
    description=(
        '列出「待我审批」的单：标题、摘要、发起人、当前步骤、是否加急。'
        '用户问「我有哪些待办 / 有什么要我批的 / 张三那张请假在不在我这」时用它。'
        'keyword 可以是几个词、用空格分开（如「孙强 报销」），每个词都要在标题 / 摘要 / 发起人里出现；'
        '拿不准就不带 keyword，看全部。'
    ),
    domain='workflow',
)
async def wf_todo_list(db: AsyncSession, ctx: RunContext, keyword: str | None = None) -> dict[str, Any]:
    # 🔴 关键词按空格拆开、每个词都要命中，在这里筛 —— 不交给查询层的整串 LIKE：本地真跑时模型传的是
    # 「孙强 苏州 演示：差旅报销」，整串当一个子串永远匹配不上，模型拿到 0 张就放弃了，而那张单就在待办里
    page = await query_service.todo(db, ctx.user.id, keyword=None, page=1, size=_TODO_SCAN)
    terms = (keyword or '').split()
    rows = [
        r
        for r in page['items']
        if all(term in f'{r["title"]} {r["summary"] or ""} {r.get("initiator_name") or ""}' for term in terms)
    ]
    out: dict[str, Any] = {
        'total': len(rows),
        'items': [
            {
                'instance_id': str(r['id']),
                'title': r['title'],
                'summary': r['summary'],
                'initiator': r.get('initiator_name'),
                'step': r.get('node_name'),
                'urgent': r['urgent'],
                'arrived_time': _when(r.get('arrived_time')),
            }
            for r in rows[:20]
        ],
    }
    if terms and not rows and page['items']:
        # 告诉模型还能怎么查，别让它拿着 0 张就跟用户说「没有」
        out['hint'] = f'按这些词没找到；你一共有 {page["total"]} 张待办，不带 keyword 再查一次能看到全部'
    if page['total'] > _TODO_SCAN:
        out['note'] = f'待办超过 {_TODO_SCAN} 张，只在最近的 {_TODO_SCAN} 张里找了'
    return out


@ai_tool(
    name='wf_instance_detail',
    description=(
        '看一张审批单：填了什么、走到哪一步、你现在能对它做什么（can_do）。字段已经按你的权限裁过，'
        f'看不到的字段不在里面，不要猜。{_ID_HINT}'
    ),
    domain='workflow',
)
async def wf_instance_detail(db: AsyncSession, ctx: RunContext, instance_id: str) -> dict[str, Any]:
    d = await query_service.detail(db, _pk(instance_id), _actor(ctx))
    data = d['form_data']
    fields = [
        {'label': f.get('label'), 'value': data[f['id']]}
        for f in d['form_schema'].get('fields') or []
        if f.get('type') != 'description' and f['id'] in data
    ]
    return {
        'instance_id': str(d['instance']['id']),
        'title': d['instance']['title'],
        'status': d['instance']['status'],
        'workflow': d['instance'].get('definition_name'),
        'initiator': d['instance'].get('initiator_name'),
        'submitted_time': _when(d['instance'].get('created_time')),
        'fields': fields,
        'can_do': [c['action'] for c in d['capabilities'] if c['enabled']],
    }


async def _doable(db: AsyncSession, ctx: RunContext, instance_id: str, action: Action) -> dict[str, Any]:
    """预演用：这张单现在能不能由你做这个动作（能力信封，和网页上的按钮同一个函数）"""
    d = await query_service.detail(db, _pk(instance_id), _actor(ctx))
    cap = next((c for c in d['capabilities'] if c['action'] == action.value), None)
    if cap is None or not cap['enabled']:
        why = f'：{cap["reason"]}' if cap and cap.get('reason') else '（这张单现在不在你手上，或者已经结束了）'
        raise ValueError(f'你现在不能{_ACTION_NAMES[action]}「{d["instance"]["title"]}」{why}')
    return d


async def _act(db: AsyncSession, ctx: RunContext, instance_id: str, action: Action, **kwargs: Any) -> dict[str, Any]:
    # 幂等键每次新生成：确认令牌本身就是一次性的（`chat_service.confirm_tool` 抢占），同一次确认不会执行两遍
    await runtime_service.act(
        db, instance_id=_pk(instance_id), action=action, actor=_actor(ctx), key=f'ai-{uuid.uuid4().hex}', **kwargs
    )
    return {'instance_id': instance_id, 'action': action.value, 'done': True}


async def _preview_approve(db: AsyncSession, ctx: RunContext, instance_id: str, opinion: str | None = None) -> str:
    d = await _doable(db, ctx, instance_id, Action.approve)
    words = _own_words(ctx, opinion)
    tail = f'，意见：「{words}」' if words else ''
    return f'将以你本人的身份同意「{d["instance"]["title"]}」{tail}'


@ai_tool(
    name='wf_approve',
    description=(
        f'以你本人的身份同意一张待你审批的单。会先请你确认再执行。opinion 只填用户的原话，用户没说就不填。{_ID_HINT}'
    ),
    domain='workflow',
    mutating=True,
    self_authorized=True,
    preview=_preview_approve,
)
async def wf_approve(db: AsyncSession, ctx: RunContext, instance_id: str, opinion: str | None = None) -> dict[str, Any]:
    return await _act(db, ctx, instance_id, Action.approve, opinion=opinion)


async def _preview_reject(db: AsyncSession, ctx: RunContext, instance_id: str, opinion: str) -> str:
    words = _own_words(ctx, opinion)
    if not words:
        raise ValueError('驳回必须带意见：请向用户要他的原话，不要自己拟')
    d = await _doable(db, ctx, instance_id, Action.reject)
    return f'将以你本人的身份驳回「{d["instance"]["title"]}」，意见原文：「{words}」'


@ai_tool(
    name='wf_reject',
    description=(
        '以你本人的身份驳回一张待你审批的单（整张单结束）。会先请你确认再执行。'
        '🔴 opinion 必须是用户自己说的驳回理由原话：用户没说理由就先问他，'
        '不要替他拟、不要改写、不要填「未提供」之类的占位话。'
        f'{_ID_HINT}'
    ),
    domain='workflow',
    mutating=True,
    self_authorized=True,
    preview=_preview_reject,
)
async def wf_reject(db: AsyncSession, ctx: RunContext, instance_id: str, opinion: str) -> dict[str, Any]:
    if not opinion or not opinion.strip():
        raise ValueError('驳回必须带意见')
    return await _act(db, ctx, instance_id, Action.reject, opinion=opinion)


async def _resolve_user(db: AsyncSession, name: str) -> dict[str, Any]:
    """转交给谁：人说的是名字。按用户名或昵称**精确**匹配，重名不猜（同部门负责人那条，见 AI 分册）"""
    wanted = name.strip()
    hits = await query_service.users_named(db, wanted)
    if not hits:
        raise ValueError(f'找不到「{wanted}」：按用户名或昵称精确匹配，必须是在职的账号')
    if len(hits) > 1:
        names = '、'.join(f'{r.get("nickname")}（用户名 {r.get("username")}）' for r in hits)
        raise ValueError(f'「{wanted}」对应多个人：{names}。请向用户确认是哪一位，再用用户名重试')
    return hits[0]


async def _preview_transfer(
    db: AsyncSession, ctx: RunContext, instance_id: str, to_user: str, opinion: str | None = None
) -> str:
    d = await _doable(db, ctx, instance_id, Action.transfer)
    who = await _resolve_user(db, to_user)
    words = _own_words(ctx, opinion)
    tail = f'，附言：「{words}」' if words else ''
    return f'将把「{d["instance"]["title"]}」转交给 {who.get("nickname")}（{who.get("username")}）{tail}'


@ai_tool(
    name='wf_transfer',
    description=(
        '把一张待你审批的单转交给别人办（他替你审）。会先请你确认再执行。'
        'to_user 直接填用户说的名字（用户名或昵称都行），重名时工具会列出候选。'
        f'{_ID_HINT}'
    ),
    domain='workflow',
    mutating=True,
    self_authorized=True,
    preview=_preview_transfer,
)
async def wf_transfer(
    db: AsyncSession, ctx: RunContext, instance_id: str, to_user: str, opinion: str | None = None
) -> dict[str, Any]:
    who = await _resolve_user(db, to_user)
    return await _act(db, ctx, instance_id, Action.transfer, opinion=opinion, target_user_ids=[int(who['id'])])
