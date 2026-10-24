"""设计器：一句话生成表单 + 流程（#111 第 1 条）

管理员说一句「做一个采购申请：物品明细（名称 / 数量 / 单价），合计自动算；超过 1 万走财务总监」，
模型产出 `{form, model}` 两棵 JSON 树，**只回给设计器放进草稿**（前端 `draft ?? baseline` 那一层），
人点保存 / 发布才生效。
这里什么都不写，除了一行调用记录（`wf_ai_assist`，不变式 5）。

四条约束：

- 🔴 **提示词里的「目录」从 `engine/schema.py` 生成**（Pydantic 的 JSON Schema），不手抄：手抄的那份迟早和代码漂移，
  漂了的表现是模型照着过期的说明产出、校验又不认。手写的只有语义规则 —— 漏写也有发布校验回喂兜着
- 🔴 **两层把关、回喂一轮**：形状（Pydantic）+ 语义（`validate_publish`，和点「发布」同一个函数）。
  有问题就把问题原样回给模型修一轮；修完还不如第一次（形状都不对了）就用第一次的
- 🔴 **形状不对的东西永远不回给前端**（#111 验收：100% 过形状校验）。设计器按这两棵树渲染，形状错了是白屏，
  不是「有几个问题待解决」。语义问题照常回给前端，界面列出来、点一下定位到节点 / 字段
- **模型编出来的 ID 不留**：角色只能从给它的清单里选，不在清单里的丢掉（变成「没配审批人」，人来选）；
  具体某个人它不知道 ID，提示词要求留空。`validate_publish` 不查角色在不在 —— 不在这里丢，就是一条发布得出去、
  运行时取不到人的流程
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

from typing import TYPE_CHECKING, Any

from pydantic import ValidationError
from sqlalchemy import select

from backend.app.admin.model import Role
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.plugin.workflow.engine.flow import index_nodes, validate_publish
from backend.plugin.workflow.engine.schema import FlowModel, FormSchema
from backend.plugin.workflow.service.ai_assist import build_client, complete, record

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

#: 一轮模型调用最多等多久。两轮（生成 + 修一轮）要落在 nginx 的 300 秒之内（`apps/web/nginx.conf`）
ROUND_TIMEOUT = 90
#: 给模型看的角色最多几个（按名称排序）
_ROLE_LIMIT = 100
#: 这些问题不回喂给模型：没配审批人是**预期**的（具体的人它不知道 ID，提示词让它留空），
#: 回喂只会逼它编一个
_LEFT_FOR_HUMAN = frozenset({'APPROVER_EMPTY'})

_RULES = """\
语义规则（违反了发布会被拦）：
1. 字段 id：字母开头，只含字母 / 数字 / 下划线，全表唯一；流程节点 id 全局唯一（开始节点 id 固定写 "start"）
2. select / multiselect 必须有 options，option 的 value 互不相同（用英文小写，如 "sick"）
3. 金额用 amount（precision 2）；明细表用 table + columns，
   列类型只能是 text / textarea / number / amount / date / select，列上不能有 visibleWhen / calc
4. calc（自动计算）只能放在 number / amount 字段上，源字段要排在它**前面**：
   - {"kind": "days", "field": 日期区间字段 id}：自己必须是 number，源必须是 daterange
   - {"kind": "sum", "field": 明细表字段 id, "column": 列 id}：合计明细表里一列 number / amount
   - 🔴 **没有乘法**：「数量 × 单价」算不出来。明细里有数量和单价、又要合计金额时，给明细表**再加一列 amount「金额」**
     （填表人自己填这一行的金额），合计对「金额」这一列 sum。**不要对「单价」列求和** —— 那个数没有意义
5. visibleWhen（显示条件）只能引用排在它前面的字段
6. 条件分支（type "condition"）至少两个 branches，**恰好一个** "default": true 的兜底分支（它不写 when）；
   其余分支写 when，when 里的 var 必须是表单字段 id，
   且字段类型是 text / number / amount / date / select / multiselect / user / dept
7. 审批人 assignee 的 kind：
   - "dept_leader" + level（1 = 发起人所在部门负责人，2 = 再上一级…）
   - "role" + role_ids：**只能从下面的角色清单里选 id**，清单里没有合适的就用别的方式
   - "initiator"（发起人自己）· "select_on_start"（发起人提交时自选）· "var_user" + field（取某个 user 字段里的人）
   - 用户点名了**具体某个人**（「交给张三审」）：你不知道他的 ID，把 assignee 写成 null，管理员会在设计器里选
8. 条件分支之后的节点挂在条件节点的 next 上；每个分支自己的节点挂在 branch 的 child 上
9. 不要输出 aiReview，节点上也不要输出 aiApprove：AI 预审 / AI 自动同意只能由管理员自己开
"""

# 这个示例本身要过发布校验（`test_ai_design.py` 守着）：示例自相矛盾，模型照着学就是错的
_EXAMPLE = {
    'form': {
        'schemaVersion': 1,
        'fields': [
            {
                'id': 'leave_type',
                'type': 'select',
                'label': '请假类型',
                'required': True,
                'options': [
                    {'label': '年假', 'value': 'annual'},
                    {'label': '事假', 'value': 'personal'},
                    {'label': '病假', 'value': 'sick'},
                ],
            },
            {'id': 'period', 'type': 'daterange', 'label': '请假时间', 'required': True},
            {'id': 'days', 'type': 'number', 'label': '请假天数', 'calc': {'kind': 'days', 'field': 'period'}},
            {'id': 'reason', 'type': 'textarea', 'label': '事由', 'required': True},
            {
                'id': 'proof',
                'type': 'attachment',
                'label': '病假证明',
                'visibleWhen': {'var': 'leave_type', 'op': 'eq', 'value': 'sick'},
            },
        ],
    },
    'model': {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'approval',
                'id': 'leader',
                'name': '直属主管',
                'assignee': {'kind': 'dept_leader', 'level': 1},
                'next': {
                    'type': 'condition',
                    'id': 'by_days',
                    'name': '按天数',
                    'branches': [
                        {
                            'id': 'long',
                            'name': '超过 3 天',
                            'when': {'var': 'days', 'op': 'gt', 'value': 3},
                            'child': {
                                'type': 'approval',
                                'id': 'upper',
                                'name': '上级主管',
                                'assignee': {'kind': 'dept_leader', 'level': 2},
                            },
                        },
                        {'id': 'other', 'name': '其他', 'default': True},
                    ],
                },
            },
        },
    },
}


def _catalog() -> str:
    def dump(m: type[FormSchema | FlowModel]) -> str:
        return json.dumps(m.model_json_schema(), ensure_ascii=False, separators=(',', ':'))

    return f'表单 form 的 JSON Schema：\n{dump(FormSchema)}\n\n流程 model 的 JSON Schema：\n{dump(FlowModel)}'


SYSTEM_PROMPT = f"""你是审批流设计助手。管理员用一句话描述他要的审批，你产出表单和流程两棵 JSON 树。

只输出一个 JSON 对象：{{"form": {{...}}, "model": {{...}}}}。不要解释，不要 Markdown 代码块以外的任何文字。
字段 label、节点 name 用中文，简短。管理员没说到的不要自己加审批环节；没说审批人的步骤默认部门负责人。

{_catalog()}

{_RULES}
示例（「请假：类型、时间、天数自动算、事由，病假要传证明；主管审，超过 3 天再给上一级主管审」）：
{json.dumps(_EXAMPLE, ensure_ascii=False)}
"""

#: 提示词版本 = 系统提示词原文的 sha256 前 12 位。目录从 schema 生成，schema 一变版本就跟着变，不用人记得改号
PROMPT_VERSION = hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12]


async def _roles(db: AsyncSession) -> list[dict[str, str]]:
    rows = await db.execute(
        select(Role.id, Role.name, Role.code)
        .where(Role.status == 1, Role.deleted == 0)
        .order_by(Role.name)
        .limit(_ROLE_LIMIT)
    )
    return [{'id': str(r.id), 'name': r.name, 'code': r.code} for r in rows]


def _user_message(prompt: str, roles: list[dict[str, str]]) -> str:
    listing = json.dumps(roles, ensure_ascii=False) if roles else '（没有可用的角色）'
    return f'可选的角色（assignee.kind = "role" 时 role_ids 只能用这里的 id）：\n{listing}\n\n管理员的描述：\n{prompt}'


def extract_json(text: str) -> tuple[dict[str, Any] | None, str | None]:
    """模型的回答里取出那个 JSON 对象：（对象，取不出来的原因）。容忍 ```json 代码块和前后的客套话，别的不猜。

    🔴 **不替它配括号**：真模型（Qwen3-VL）实测少过一个 `}`。在末尾补上能解析，但缺的那一个可能在中间 ——
    补在末尾就是另一棵嵌套关系不同、而且可能照样过校验的树。把解析器的原话（在第几个字符）回给它修
    """
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        return None, '回答里没有 JSON 对象'
    try:
        out = json.loads(text[start : end + 1])
    except ValueError as e:
        return None, f'JSON 解析失败（{e}）—— 多半是括号没配平，检查每个 {{ [ 都有对应的 }} ]'
    if not isinstance(out, dict) or not isinstance(out.get('form'), dict) or not isinstance(out.get('model'), dict):
        return None, '顶层要是 {"form": {...}, "model": {...}}'
    return out, None


def _strip_ai_switches(model: dict[str, Any]) -> None:
    """🔴 AI 的开关只能由管理员亲手开：生成的流程里带着 `aiApprove`（目录是从 schema 生成的，里面就有这个字段），
    管理员不碰那个开关就能把「AI 自动同意」发布出去，而且是模型挑的门槛"""
    model.pop('aiReview', None)
    for ref in index_nodes(model).values():
        ref.node.pop('aiApprove', None)


def _strip_unknown_roles(model: dict[str, Any], allowed: set[str]) -> None:
    """不在清单里的角色 ID 是模型编的：丢掉。丢空了就是「没配审批人」，发布校验会指到那个节点"""
    try:
        nodes = index_nodes(model)
    except Exception:  # 形状不对，下一步的形状校验会报
        return
    for ref in nodes.values():
        rules = [ref.node.get('assignee'), *(ref.node.get('targets') or [])]
        for rule in rules:
            if isinstance(rule, dict) and rule.get('kind') == 'role':
                rule['role_ids'] = [str(r) for r in rule.get('role_ids') or [] if str(r) in allowed]


def _shape_errors(name: str, shape: type[FormSchema | FlowModel], tree: dict[str, Any]) -> list[str]:
    try:
        shape.model_validate(tree)
    except ValidationError as e:
        return [f'{name}.{".".join(map(str, x["loc"]))}: {x["msg"]}' for x in e.errors()[:12]]
    return []


def check(candidate: dict[str, Any], allowed_roles: set[str]) -> tuple[str | None, list[dict[str, str]]]:
    """（形状错误，语义问题）。形状不对时语义问题是空的 —— 它们假设形状是对的"""
    form, model = candidate['form'], candidate['model']
    form.setdefault('schemaVersion', 1)
    model.setdefault('schemaVersion', 1)
    # 两棵树分开校验、路径带上树名：只说 `fields.0.type`，模型分不清是哪棵树
    lines = _shape_errors('form', FormSchema, form) + _shape_errors('model', FlowModel, model)
    if lines:
        return '形状校验没过：\n' + '\n'.join(lines), []
    _strip_ai_switches(model)
    _strip_unknown_roles(model, allowed_roles)
    return None, validate_publish(form, model)


def _feedback(shape_error: str | None, issues: list[dict[str, str]]) -> str | None:
    if shape_error:
        return shape_error
    errs = [i for i in issues if i['level'] == 'ERROR' and i['code'] not in _LEFT_FOR_HUMAN]
    if not errs:
        return None
    lines = [
        f'- {i["code"]}：{i["message"]}' + ''.join(f'（{k}={i[k]}）' for k in ('nodeId', 'fieldId') if i.get(k))
        for i in errs
    ]
    return '发布校验报了这些问题：\n' + '\n'.join(lines)


async def generate(db: AsyncSession, *, definition_id: int, prompt: str, user_id: int) -> dict[str, Any]:
    """生成一份草稿：`{form, model, issues, model_name, rounds}`。形状不对的永远不回"""
    roles = await _roles(db)
    allowed = {r['id'] for r in roles}
    client = await build_client(db)
    model_name = getattr(client, 'model', None)
    messages = [
        {'role': 'system', 'content': SYSTEM_PROMPT},
        {'role': 'user', 'content': _user_message(prompt, roles)},
    ]
    started = time.perf_counter()
    tokens = {'prompt_tokens': 0, 'completion_tokens': 0}
    best: tuple[dict[str, Any], list[dict[str, str]]] | None = None
    rounds = 0
    error: str | None = None
    try:
        for _ in range(2):
            rounds += 1
            text, usage = await asyncio.wait_for(complete(client, messages), timeout=ROUND_TIMEOUT)
            for k in tokens:
                tokens[k] += (usage or {}).get(k) or 0
            candidate, unreadable = extract_json(text)
            shape_error, issues = (unreadable, []) if candidate is None else check(candidate, allowed)
            if shape_error is None:
                best = (candidate, issues)
            feedback = _feedback(shape_error, issues)
            if feedback is None:
                break
            messages += [
                {'role': 'assistant', 'content': text},
                {'role': 'user', 'content': f'{feedback}\n\n只修这些问题，别的不动，重新输出完整的 JSON 对象。'},
            ]
            error = feedback
    except TimeoutError:
        error = t('error.workflow.ai_model_timeout')
    except errors.BaseExceptionError as e:
        # 网关报的错（401 / 429 / 404…，`_explain_http_error` 已经翻成人话）：照样记一行 —— 失败的调用最要留痕
        error = e.msg
    except Exception as e:
        log.exception('设计器 AI 生成调用模型失败')
        error = str(e) or type(e).__name__
    await record(
        db,
        kind='design',
        user_id=user_id,
        definition_id=definition_id,
        status='done' if best else 'failed',
        prompt_version=PROMPT_VERSION,
        rounds=rounds,
        model=model_name,
        duration_ms=int((time.perf_counter() - started) * 1000),
        prompt_tokens=tokens['prompt_tokens'] or None,
        completion_tokens=tokens['completion_tokens'] or None,
        error=None if best else (error or '')[:512],
    )
    if best is None:
        raise errors.RequestError(msg=t('error.workflow.ai_design_failed', reason=(error or '')[:200]))
    candidate, issues = best
    return {
        'form': candidate['form'],
        'model': candidate['model'],
        'issues': issues,
        'model_name': model_name,
        'rounds': rounds,
    }
