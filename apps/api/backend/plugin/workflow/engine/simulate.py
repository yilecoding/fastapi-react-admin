"""流程试算：不写库，推演「从这里往后会经过哪些步骤、各由谁办」。

两个调用方，都是给人看的预告，不参与任何判定：

- 发起页：按当前填的表单实时算（条件分支跟着天数 / 金额变），飞书的「审批流程」预览
- 详情页：实例还在跑时，从当前节点往后算「还没到的步骤」

🔴 **和 `runtime_service._advance` 必须走同一套规则**（同一个 `pick_branch`、同一个
`assignee.resolve`、同一套 `onEmpty`），否则预告和实际会对不上 —— 用户看到的是「说好给张三审，
结果到了李四那里」。改推进逻辑时两边一起改；`test_preview_matches_what_actually_happens` 守着。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from backend.plugin.workflow.engine import assignee as assignee_rules
from backend.plugin.workflow.engine.flow import condition_variables, index_nodes, pick_branch
from backend.plugin.workflow.enums import OnEmpty

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

#: 防御：手改过的快照里如果出现环，别死循环
_MAX_STEPS = 200


async def simulate(
    db: AsyncSession,
    model: dict[str, Any],
    *,
    form_data: dict[str, Any],
    initiator_id: int,
    initiator_dept_id: int | None,
    selected: dict[str, list[str]],
    start_from: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """返回步骤列表。每步：`{node_id, name, type, mode, users:[{id,name}], outcome}`。

    outcome：
    - `ok`：有人办
    - `pick`：发起人自选、还没选
    - `skip`：找不到人，按配置跳过
    - `admin`：找不到人，转给了管理员（users 是管理员）
    - `reject`：找不到人，会被自动驳回 —— 之后不会再有步骤
    """
    nodes = index_nodes(model)
    variables = condition_variables(form_data, initiator_dept_id)
    steps: list[dict[str, Any]] = []
    node = start_from
    while node is not None and len(steps) < _MAX_STEPS:
        kind = node['type']
        if kind == 'condition':
            # 取值不全（比如天数还没填）时 pick_branch 落到兜底分支 —— 预告跟着当前输入走
            br = pick_branch(node, variables)
            node = br.get('child') or nodes[node['id']].after
            continue

        resolve_kw = {
            'initiator_id': initiator_id,
            'initiator_dept_id': initiator_dept_id,
            'form_data': form_data,
            'selected': selected,
            'node_id': node['id'],
        }
        if kind == 'cc':
            users: list[tuple[int, str]] = []
            for rule in node.get('targets') or []:
                users += await assignee_rules.resolve(db, rule, **resolve_kw)
            steps.append(_step(node, list(dict.fromkeys(users)), 'ok' if users else 'skip'))
            node = nodes[node['id']].after
            continue

        rule = node.get('assignee') or {}
        users = await assignee_rules.resolve(db, rule, **resolve_kw)
        if users:
            steps.append(_step(node, users, 'ok'))
        elif rule.get('kind') == 'select_on_start' and not selected.get(node['id']):
            steps.append(_step(node, [], 'pick'))
        else:
            on_empty = OnEmpty(node.get('onEmpty') or OnEmpty.reject)
            if on_empty == OnEmpty.skip:
                steps.append(_step(node, [], 'skip'))
            else:
                admins = (
                    await assignee_rules.superusers(db, initiator_id=initiator_id) if on_empty == OnEmpty.admin else []
                )
                if admins:
                    steps.append(_step(node, admins, 'admin'))
                else:
                    steps.append(_step(node, [], 'reject'))
                    break
        node = nodes[node['id']].after
    return steps


def _step(node: dict[str, Any], users: list[tuple[int, str]], outcome: str) -> dict[str, Any]:
    return {
        'node_id': node['id'],
        'name': node.get('name') or '',
        'type': node['type'],
        'mode': node.get('mode') or 'any',
        'users': [{'id': u, 'name': n} for u, n in users],
        'outcome': outcome,
    }
