"""表单数据校验与字段权限（#107 设计 6.5）

🔴 **服务端按快照里的 schema 校验**，前端的 zod 只是为了体验。两边的规则来自同一份
schema，但只有这一份算数。

值的形状（前后端契约）：

| 控件 | 值 |
|---|---|
| text / textarea / select | 字符串 |
| number | JSON 数字 |
| amount | **十进制字符串**（不用 float，`0.1 + 0.2` 那种误差落到金额上就是钱） |
| date | `YYYY-MM-DD` |
| daterange | `[开始, 结束]` |
| multiselect | 字符串数组 |
| user / dept | 雪花 ID **字符串**（硬纪律 6）；`multiple` 时是数组 |
| attachment | 文件 ID 字符串数组 |
| table | 行对象数组，每行按 `columns` 校验 |
| description | 不收值 |
"""

from __future__ import annotations

import re

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from backend.plugin.workflow.enums import FieldPerm

_ID = re.compile(r'^\d{1,20}$')

#: 字段值的长度上限 —— 表单数据整份存进一个 TEXT 列，不限的话一个字段就能塞几 MB
_MAX_TEXT = 2000
_MAX_ROWS = 200


class FormDataError(ValueError):
    """表单数据不合法。`errors` 是 字段 ID → 原因"""

    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__('; '.join(f'{k}: {v}' for k, v in errors.items()))
        self.errors = errors


def _empty(v: Any) -> bool:
    return v is None or v in ('', [])


def _check(field: dict[str, Any], v: Any) -> tuple[Any, str | None]:  # ruff:ignore[complex-structure]
    """校验并归一一个值，返回 (归一后的值, 错误)"""
    t = field['type']
    if t in {'text', 'textarea'}:
        if not isinstance(v, str):
            return v, '应为文本'
        if len(v) > _MAX_TEXT:
            return v, f'不能超过 {_MAX_TEXT} 个字'
        return v, None
    if t == 'number':
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return v, '应为数字'
        return v, None
    if t == 'amount':
        try:
            d = Decimal(str(v))
        except InvalidOperation:
            return v, '应为金额'
        if not d.is_finite():
            return v, '应为金额'
        precision = field.get('precision')
        if precision is None:
            precision = 2
        return str(d.quantize(Decimal(1).scaleb(-precision))), None
    if t == 'date':
        try:
            return date.fromisoformat(str(v)).isoformat(), None
        except ValueError:
            return v, '应为日期 YYYY-MM-DD'
    if t == 'daterange':
        if not isinstance(v, list) or len(v) != 2:
            return v, '应为 [开始, 结束]'
        try:
            a, b = date.fromisoformat(str(v[0])), date.fromisoformat(str(v[1]))
        except ValueError:
            return v, '应为日期 YYYY-MM-DD'
        if a > b:
            return v, '开始不能晚于结束'
        return [a.isoformat(), b.isoformat()], None
    if t == 'select':
        allowed = {o['value'] for o in field.get('options') or []}
        return (v, None) if v in allowed else (v, '不是可选值')
    if t == 'multiselect':
        allowed = {o['value'] for o in field.get('options') or []}
        if not isinstance(v, list) or not all(x in allowed for x in v):
            return v, '不是可选值'
        return list(dict.fromkeys(v)), None
    if t in {'user', 'dept'}:
        items = v if field.get('multiple') else [v]
        if not isinstance(items, list) or not all(isinstance(x, str) and _ID.match(x) for x in items):
            # ID 必须是字符串：前端要是传了数字，2^53 之上的已经被 JSON.parse 改过了，
            # 收下来就是一个指向别人的 ID（硬纪律 6）
            return v, '应为 ID 字符串'
        return (list(dict.fromkeys(items)) if field.get('multiple') else v), None
    if t == 'attachment':
        if not isinstance(v, list) or not all(isinstance(x, str) and _ID.match(x) for x in v):
            return v, '应为文件 ID 字符串数组'
        return v, None
    if t == 'table':
        if not isinstance(v, list) or not all(isinstance(r, dict) for r in v):
            return v, '应为行数组'
        if len(v) > _MAX_ROWS:
            return v, f'最多 {_MAX_ROWS} 行'
        rows = []
        for i, row in enumerate(v):
            out: dict[str, Any] = {}
            for col in field.get('columns') or []:
                cv = row.get(col['id'])
                if _empty(cv):
                    if col.get('required'):
                        return v, f'第 {i + 1} 行「{col["label"]}」必填'
                    continue
                nv, e = _check(col, cv)
                if e:
                    return v, f'第 {i + 1} 行「{col["label"]}」{e}'
                out[col['id']] = nv
            rows.append(out)
        return rows, None
    return v, '不支持的控件'


def validate_form_data(form_schema: dict[str, Any], data: dict[str, Any], *, only: set[str] | None = None) -> dict:
    """按 schema 校验整份表单，返回归一后的数据（只保留 schema 里有的字段）。

    :param only: 只校验这些字段（审批时合并可编辑字段用）；None = 全部
    """
    if not isinstance(data, dict):
        raise FormDataError({'_': '表单数据应为对象'})
    errors: dict[str, str] = {}
    out: dict[str, Any] = {}
    for f in form_schema.get('fields') or []:
        fid = f['id']
        if f['type'] == 'description' or (only is not None and fid not in only):
            continue
        v = data.get(fid)
        if _empty(v):
            if f.get('required'):
                errors[fid] = f'「{f["label"]}」必填'
            continue
        nv, e = _check(f, v)
        if e:
            errors[fid] = f'「{f["label"]}」{e}'
        else:
            out[fid] = nv
    if errors:
        raise FormDataError(errors)
    return out


# ── 字段权限 ─────────────────────────────────────────────────────────────────


def node_field_perm(node: dict[str, Any] | None, field_id: str) -> FieldPerm:
    """某个审批节点上某个字段的权限，没配就是只读"""
    if node is None:
        return FieldPerm.readonly
    return FieldPerm((node.get('fieldPerms') or {}).get(field_id, FieldPerm.readonly))


def hidden_fields_for(
    form_schema: dict[str, Any],
    approval_nodes: list[dict[str, Any]],
    *,
    see_all: bool,
    participant_nodes: list[dict[str, Any]],
) -> set[str]:
    """这个查看人看不到哪些字段。

    - 发起人、实例监控里的管理员：全都看得到
    - 当过审批人的：只要在他办过的**某一个**节点上不是 hidden 就看得到
    - 其余人（抄送人、只是被转办过的）：只要在**任何**节点上被设成 hidden 就看不到 ——
      抄送节点没有字段权限，按最严的算，不把审批人都看不到的东西摊给抄送人
    """
    if see_all:
        return set()
    hidden: set[str] = set()
    for f in form_schema.get('fields') or []:
        fid = f['id']
        if participant_nodes:
            if all(node_field_perm(n, fid) == FieldPerm.hidden for n in participant_nodes):
                hidden.add(fid)
        elif any(node_field_perm(n, fid) == FieldPerm.hidden for n in approval_nodes):
            hidden.add(fid)
    return hidden


def editable_fields(form_schema: dict[str, Any], node: dict[str, Any]) -> set[str]:
    return {
        f['id']
        for f in form_schema.get('fields') or []
        if f['type'] != 'description' and node_field_perm(node, f['id']) == FieldPerm.editable
    }
