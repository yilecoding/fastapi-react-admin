"""流程树的导航与条件求值 —— 纯函数，不碰数据库

运行时读的是原始 `dict`（见 `schema.py` 的头注释），这里的函数都按 dict 写。

树的形状：每个节点有 `next`；条件节点的每个分支有一棵 `child` 子树，子树走完
回到条件节点的 `next`。没有并行分支，所以「当前在哪」永远是一个节点 ID。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any

from backend.plugin.workflow.engine.schema import COLUMN_TYPES, CONDITION_TYPES, FlowModel, FormSchema

if TYPE_CHECKING:
    from collections.abc import Callable


@dataclass(frozen=True)
class NodeRef:
    node: dict[str, Any]
    #: 这个节点走完之后去哪：它自己的 `next`，没有就是外层条件节点的出口（None = 结束）
    after: dict[str, Any] | None


def index_nodes(model: dict[str, Any]) -> dict[str, NodeRef]:
    """节点 ID → (节点, 走完之后的下一个节点)。

    「走完之后」要带上外层的出口：分支子树最后一个节点的 `next` 是 null，
    但它走完不是结束，是回到条件节点的 `next`。
    """
    out: dict[str, NodeRef] = {}

    def walk(node: dict[str, Any] | None, cont: dict[str, Any] | None) -> None:
        while node is not None:
            after = node.get('next') or cont
            out[node['id']] = NodeRef(node, after)
            if node['type'] == 'condition':
                for br in node.get('branches') or []:
                    walk(br.get('child'), after)
            node = node.get('next')

    walk(model['root'], None)
    return out


# ── 条件 ─────────────────────────────────────────────────────────────────────


def _num(v: Any) -> Decimal | None:
    if v is None or isinstance(v, bool) or (isinstance(v, str) and not v):
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        return None
    # 'NaN' / 'sNaN' / 'Infinity' 也能变成 Decimal，但拿去比较会抛 InvalidOperation → 500。
    # 条件里出现这种值（文本字段里打了个 NaN）只能当「不是数字」
    return d if d.is_finite() else None


def _cmp_value(v: Any) -> Any:
    """统一成可比较的形状：数字 / 金额 → Decimal，日期串保持字符串（ISO 格式按字典序可比）"""
    n = _num(v)
    if n is not None:
        return n
    if isinstance(v, date):
        return v.isoformat()
    return v


def evaluate(cond: dict[str, Any] | None, variables: dict[str, Any]) -> bool:  # ruff:ignore[complex-structure]
    """条件求值。变量取不到当作 None —— 除了 `empty` 之外的比较都不成立，不抛异常。

    ⚠️ 不成立不等于出错：发布校验（`validate_publish`）已经保证引用的变量在表单里存在，
    这里取不到只可能是非必填字段没填，那本来就该走兜底分支。
    """
    if not cond:
        return True
    if cond.get('all') is not None:
        return all(evaluate(c, variables) for c in cond['all'])
    if cond.get('any') is not None:
        return any(evaluate(c, variables) for c in cond['any'])

    op = cond.get('op')
    left = variables.get(cond.get('var') or '')
    right = cond.get('value')
    if op == 'empty':
        return left in (None, '', [])
    if op == 'not_empty':
        return left not in (None, '', [])
    if left in (None, ''):
        return False
    match op:
        case 'eq':
            return _cmp_value(left) == _cmp_value(right)
        case 'ne':
            return _cmp_value(left) != _cmp_value(right)
        case 'in' | 'not_in':
            pool = [_cmp_value(x) for x in (right if isinstance(right, list) else [right])]
            lefts = left if isinstance(left, list) else [left]
            hit = any(_cmp_value(x) in pool for x in lefts)
            return hit if op == 'in' else not hit
        case 'contains':
            return isinstance(left, list) and str(right) in [str(x) for x in left]
        case 'gt' | 'gte' | 'lt' | 'lte':
            a, b = _cmp_value(left), _cmp_value(right)
            if type(a) is not type(b):
                return False
            return {'gt': a > b, 'gte': a >= b, 'lt': a < b, 'lte': a <= b}[op]
    return False


def pick_branch(node: dict[str, Any], variables: dict[str, Any]) -> dict[str, Any]:
    """按顺序取第一个成立的分支，都不成立走兜底。发布校验保证兜底分支存在"""
    default = None
    for br in node['branches']:
        if br.get('default'):
            default = br
            continue
        if evaluate(br.get('when'), variables):
            return br
    if default is None:  # 发布校验挡住了，走到这里说明快照被手改过
        raise ValueError(f'条件节点 {node["id"]} 没有兜底分支')
    return default


# ── 发布校验（#107 设计 9）──────────────────────────────────────────────────

#: 能出现在节点 `actions` 里的动作（必备的 approve / reject 不在里面：不能配掉）
OPTIONAL_ACTIONS = frozenset({'transfer', 'cc', 'send_back', 'add_sign'})

#: 条件里可以用的内置变量（不是表单字段）
BUILTIN_VARS = frozenset({'$initiator_dept'})


def validate_publish(form_json: dict[str, Any], model_json: dict[str, Any]) -> list[dict[str, str]]:  # ruff:ignore[complex-structure]
    """返回问题列表：`{level, code, nodeId?, fieldId?, message}`。有 ERROR 就不许发布。

    形状错误（Pydantic）和语义错误（这里）分两层：形状错了直接一条 SCHEMA_INVALID，
    后面的语义检查都不跑 —— 它们假设形状是对的。
    """
    issues: list[dict[str, str]] = []

    def err(code: str, message: str, **ref: str) -> None:
        issues.append({'level': 'ERROR', 'code': code, 'message': message, **ref})

    def warn(code: str, message: str, **ref: str) -> None:
        issues.append({'level': 'WARN', 'code': code, 'message': message, **ref})

    try:
        form = FormSchema.model_validate(form_json)
        FlowModel.model_validate(model_json)
    except Exception as e:
        err('SCHEMA_INVALID', str(e)[:500])
        return issues

    fields = {f.id: f for f in form.fields}
    if len(fields) != len(form.fields):
        err('FIELD_DUPLICATE_ID', '表单里有重复的字段 ID')
    for f in form.fields:
        if f.type in {'select', 'multiselect'} and not f.options:
            err('FIELD_NO_OPTIONS', f'「{f.label}」没有选项', fieldId=f.id)
        # 选项的值存进数据、条件按值判：两个选项同一个值，选哪个存的都一样，显示永远落到第一个
        for one in [f, *(f.columns or [])]:
            values = [o.value for o in one.options or []]
            if len(values) != len(set(values)):
                err('FIELD_OPTION_DUPLICATE', f'「{one.label}」有两个选项的值一样', fieldId=f.id)
        if f.type == 'table':
            if not f.columns:
                err('TABLE_NO_COLUMNS', f'明细表「{f.label}」没有列', fieldId=f.id)
            for c in f.columns or []:
                if c.type not in COLUMN_TYPES:
                    err('TABLE_COLUMN_TYPE', f'明细表「{f.label}」里不能放 {c.type}', fieldId=f.id)
    if not any(f.type != 'description' for f in form.fields):
        warn('FORM_EMPTY', '表单里没有可填写的字段')

    nodes = index_nodes(model_json)
    for fid in model_json['root'].get('fieldPerms') or {}:
        if fid not in fields:
            err(
                'FIELD_PERM_UNKNOWN', '发起人的字段权限引用了不存在的字段', nodeId=model_json['root']['id'], fieldId=fid
            )
    if len(nodes) != _count_nodes(model_json['root']):
        err('NODE_DUPLICATE_ID', '流程里有重复的节点 ID')
    approvals = 0
    for ref in nodes.values():
        n = ref.node
        nid = n['id']
        if n['type'] == 'approval':
            approvals += 1
            a = n.get('assignee')
            if not a:
                err('APPROVER_EMPTY', f'「{n["name"]}」没配审批人', nodeId=nid)
            else:
                _check_assignee(a, fields, nid, n['name'], err)
            for act in n.get('actions') or []:
                if act not in OPTIONAL_ACTIONS:
                    err('ACTION_INVALID', f'「{n["name"]}」配置了不支持的动作 {act}', nodeId=nid)
            for fid, perm in (n.get('fieldPerms') or {}).items():
                if fid not in fields:
                    err('FIELD_PERM_UNKNOWN', f'「{n["name"]}」的字段权限引用了不存在的字段', nodeId=nid, fieldId=fid)
                elif perm == 'editable' and fields[fid].type == 'description':
                    err('FIELD_PERM_INVALID', '说明文字不能设成可编辑', nodeId=nid, fieldId=fid)
        elif n['type'] == 'cc':
            if not n.get('targets'):
                warn('CC_EMPTY', f'「{n.get("name") or "抄送"}」没配抄送人', nodeId=nid)
            for t in n.get('targets') or []:
                _check_assignee(t, fields, nid, n.get('name') or '抄送', err)
        elif n['type'] == 'condition':
            defaults = [b for b in n['branches'] if b.get('default')]
            if len(defaults) != 1:
                err('CONDITION_NO_DEFAULT', '条件节点要有且只有一个兜底分支', nodeId=nid)
            for b in n['branches']:
                if b.get('default'):
                    continue
                if not b.get('when'):
                    err('CONDITION_EMPTY', f'分支「{b["name"]}」没写条件', nodeId=nid)
                for var in _vars(b.get('when')):
                    if var in BUILTIN_VARS:
                        continue
                    if any(
                        (r.node.get('fieldPerms') or {}).get(var) == 'hidden'
                        for r in nodes.values()
                        if r.node['type'] == 'approval'
                    ):
                        warn(
                            'CONDITION_VAR_HIDDEN',
                            f'分支「{b["name"]}」按一个对部分审批人隐藏的字段判断：走了哪条分支，看得到进度的人就能推出它的大概取值',
                            nodeId=nid,
                            fieldId=var,
                        )
                    f = fields.get(var)
                    if f is None:
                        err('CONDITION_VAR_UNKNOWN', f'分支「{b["name"]}」用了不存在的字段', nodeId=nid, fieldId=var)
                    elif f.type not in CONDITION_TYPES:
                        err('CONDITION_VAR_TYPE', f'「{f.label}」不能用作条件', nodeId=nid, fieldId=var)
    if approvals == 0:
        warn('NO_APPROVAL', '流程里一个审批节点都没有，发起即通过')
    ai = model_json.get('aiReview') or {}
    if ai.get('enabled') and not (ai.get('points') or '').strip():
        # 不拦：没有要点模型也能审「填得像不像话」，只是给不出针对这个流程的意见
        warn('AI_REVIEW_NO_POINTS', '开了 AI 预审但没写审核要点，预审只能给出泛泛的意见')
    _check_form_rules(form_json, model_json, nodes, err)
    return issues


def _check_form_rules(  # ruff:ignore[complex-structure]
    form_json: dict[str, Any], model_json: dict[str, Any], nodes: dict[str, NodeRef], err: Callable[..., None]
) -> None:
    """字段联动（显示条件 / 自动计算）的语义检查"""
    raw = form_json.get('fields') or []
    order = {f['id']: i for i, f in enumerate(raw)}
    by_id = {f['id']: f for f in raw}
    # 对任何人 hidden 的字段：显示条件引用它，看得到「这个字段出没出现」就能推出它的值
    hidden_any = {k for k, v in (model_json['root'].get('fieldPerms') or {}).items() if v == 'hidden'}
    for ref in nodes.values():
        hidden_any |= {k for k, v in (ref.node.get('fieldPerms') or {}).items() if v == 'hidden'}

    for i, f in enumerate(raw):
        label, fid = f.get('label') or f['id'], f['id']
        for c in f.get('columns') or []:
            if c.get('visibleWhen') or c.get('calc'):
                err('COLUMN_RULE', f'明细表「{label}」的列不支持显示条件 / 自动计算', fieldId=fid)
        for var in _vars(f.get('visibleWhen')):
            src = by_id.get(var)
            if src is None or order[var] >= i:
                err('VISIBLE_WHEN_ORDER', f'「{label}」的显示条件只能用排在它前面的字段', fieldId=fid)
            elif src['type'] not in CONDITION_TYPES:
                err('VISIBLE_WHEN_TYPE', f'「{src.get("label")}」不能用作显示条件', fieldId=fid)
            elif var in hidden_any:
                err(
                    'VISIBLE_WHEN_HIDDEN',
                    f'「{label}」的显示条件用了对部分人隐藏的「{src.get("label")}」：看到这个字段出没出现，就能推出它的值',
                    fieldId=fid,
                )
        calc = f.get('calc')
        if not calc:
            continue
        src = by_id.get(calc.get('field') or '')
        if f['type'] not in {'number', 'amount'}:
            err('CALC_TYPE', f'「{label}」不是数字 / 金额，不能自动计算', fieldId=fid)
        elif src is None or order[src['id']] >= i:
            err('CALC_SOURCE', f'「{label}」要从排在它前面的字段算', fieldId=fid)
        elif calc['kind'] == 'days' and (src['type'] != 'daterange' or f['type'] != 'number'):
            err('CALC_SOURCE', f'「{label}」按天数算要选一个日期区间，自己得是数字', fieldId=fid)
        elif calc['kind'] == 'sum':
            col = next((c for c in src.get('columns') or [] if c['id'] == calc.get('column')), None)
            if src['type'] != 'table' or col is None or col['type'] not in {'number', 'amount'}:
                err('CALC_SOURCE', f'「{label}」要选明细表里的一列数字 / 金额来合计', fieldId=fid)


def _count_nodes(node: dict[str, Any] | None) -> int:
    n = 0
    while node is not None:
        n += 1
        if node['type'] == 'condition':
            n += sum(_count_nodes(b.get('child')) for b in node['branches'])
        node = node.get('next')
    return n


def _vars(cond: dict[str, Any] | None) -> list[str]:
    if not cond:
        return []
    out: list[str] = []
    for key in ('all', 'any'):
        for c in cond.get(key) or []:
            out.extend(_vars(c))
    if cond.get('var'):
        out.append(cond['var'])
    return out


def _check_assignee(a: dict[str, Any], fields: dict, nid: str, name: str, err: Callable[..., None]) -> None:
    kind = a.get('kind')
    if kind == 'user' and not a.get('user_ids'):
        err('APPROVER_EMPTY', f'「{name}」指定了成员却一个都没选', nodeId=nid)
    if kind == 'role' and not a.get('role_ids'):
        err('APPROVER_EMPTY', f'「{name}」指定了角色却一个都没选', nodeId=nid)
    if kind == 'var_user':
        f = fields.get(a.get('field') or '')
        if f is None or f.type != 'user':
            err('APPROVER_FIELD_INVALID', f'「{name}」要取的人员字段不存在', nodeId=nid)


# ── 条件变量 ─────────────────────────────────────────────────────────────────


def condition_variables(form_data: dict[str, Any], initiator_dept_id: int | None) -> dict[str, Any]:
    """条件求值用的变量表：表单字段 + 内置变量。ID 一律字符串（硬纪律 6）"""
    return {**form_data, '$initiator_dept': str(initiator_dept_id) if initiator_dept_id else None}
