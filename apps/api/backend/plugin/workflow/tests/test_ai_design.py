"""设计器一句话生成（#111 第 1 条）：假模型按剧本出字，验我们自己的把关。

会静默出错的几处，每条一个用例：

- **形状不对的定义回给了前端**：设计器按它渲染是白屏，不是「几个问题待解决」
- **回喂修一轮**：发布校验的问题没回给模型 / 修坏了反而用了修坏的那份
- **模型编的角色 ID 留了下来**：`validate_publish` 不查角色在不在，发布得出去、运行时取不到人
- **生成就改了库里的草稿**：结果只能回给设计器，人点保存才算
- **调用没留记录**（不变式 5）：失败的那次更要有

真模型那一半在 `test_ai_design_real_model.py`。
"""

import asyncio
import json

from types import SimpleNamespace
from typing import Any, get_args

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.common.exception import errors
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.workflow.engine.flow import validate_publish
from backend.plugin.workflow.engine.schema import AssigneeKind, FieldType
from backend.plugin.workflow.service import ai_design_service
from backend.plugin.workflow.tests.conftest import ok

PURCHASE = {
    'form': {
        'fields': [
            {
                'id': 'items',
                'type': 'table',
                'label': '物品明细',
                'columns': [
                    {'id': 'name', 'type': 'text', 'label': '名称'},
                    {'id': 'amount', 'type': 'amount', 'label': '金额', 'precision': 2},
                ],
            },
            {
                'id': 'total',
                'type': 'amount',
                'label': '合计',
                'precision': 2,
                'calc': {'kind': 'sum', 'field': 'items', 'column': 'amount'},
            },
        ]
    },
    'model': {
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'condition',
                'id': 'by_total',
                'name': '按合计',
                'branches': [
                    {
                        'id': 'big',
                        'name': '超过 1 万',
                        'when': {'var': 'total', 'op': 'gt', 'value': 10000},
                        'child': {
                            'type': 'approval',
                            'id': 'cfo',
                            'name': '财务总监',
                            'assignee': {'kind': 'dept_leader', 'level': 2},
                        },
                    },
                    {'id': 'other', 'name': '其他', 'default': True},
                ],
            },
        }
    },
}


def _copy(**changes: Any) -> dict[str, Any]:
    out = json.loads(json.dumps(PURCHASE))
    for path, value in changes.items():
        *parents, last = path.split('__')
        node = out
        for p in parents:
            node = node[int(p)] if p.isdigit() else node[p]
        node[int(last) if last.isdigit() else last] = value
    return out


class _Model:
    """按剧本出字的假模型，记下每一轮收到的消息"""

    model = 'fake-model'

    def __init__(self, replies: list[str], delay: float = 0) -> None:
        self.replies = replies
        self.delay = delay
        self.seen: list[list[dict[str, str]]] = []

    async def stream_chat(
        self, messages: list[dict[str, str]], temperature: float = 0, response_format: dict | None = None
    ) -> Any:
        assert response_format == {'type': 'json_object'}, '要开 JSON 模式（见 `complete()`）'
        self.seen.append([dict(m) for m in messages])
        if self.delay:
            await asyncio.sleep(self.delay)
        reply = self.replies[len(self.seen) - 1]
        yield SimpleNamespace(text=reply, usage={'prompt_tokens': 100, 'completion_tokens': 50})


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch) -> Any:
    def install(*replies: Any, delay: float = 0) -> _Model:
        fake = _Model([r if isinstance(r, str) else json.dumps(r, ensure_ascii=False) for r in replies], delay)

        async def build(_db: Any) -> _Model:  # ruff: ignore[unused-async] —— 顶掉的原函数是 async
            return fake

        monkeypatch.setattr(ai_design_service, 'build_client', build)
        return fake

    return install


def _definition(client: TestClient, admin: dict[str, str], code: str) -> str:
    return str(ok(client.post('/sys/workflow/definitions', headers=admin, json={'code': code, 'name': code}))['id'])


def _generate(client: TestClient, admin: dict[str, str], pk: str, prompt: str = '做一个采购申请') -> Any:
    return client.post(f'/sys/workflow/definitions/{pk}/ai-generate', headers=admin, json={'prompt': prompt})


def _calls(pk: str) -> list[dict[str, Any]]:
    async def go() -> list[dict[str, Any]]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as s:
                rows = await s.execute(
                    text(
                        'SELECT kind, status, rounds, model, prompt_version, prompt_tokens, error '
                        'FROM wf_ai_assist WHERE definition_id = :d ORDER BY id'
                    ),
                    {'d': int(pk)},
                )
                return [dict(r._mapping) for r in rows]
        finally:
            await engine.dispose()

    return asyncio.run(go())


def test_the_prompt_example_passes_publish_validation() -> None:
    """提示词里的示例自相矛盾，模型照着学就是错的"""
    issues = validate_publish(ai_design_service._EXAMPLE['form'], ai_design_service._EXAMPLE['model'])
    assert [i for i in issues if i['level'] == 'ERROR'] == [], issues


def test_the_catalog_is_generated_from_the_schema() -> None:
    """目录不手抄：每一种控件 / 审批人规则都要出现在提示词里（加了新控件不用记得改提示词）"""
    for value in (*get_args(FieldType), *get_args(AssigneeKind)):
        assert f'"{value}"' in ai_design_service.SYSTEM_PROMPT, value


def test_a_good_answer_goes_back_to_the_designer_and_nothing_is_saved(
    client: TestClient, token_headers: dict[str, str], model: Any
) -> None:
    pk = _definition(client, token_headers, 'PYTEST_AID_OK')
    fake = model(f'好的，下面是定义：\n```json\n{json.dumps(PURCHASE, ensure_ascii=False)}\n```')
    data = ok(_generate(client, token_headers, pk))
    assert data['form']['fields'][1]['calc'] == {'kind': 'sum', 'field': 'items', 'column': 'amount'}
    assert data['model']['root']['next']['id'] == 'by_total'
    assert data['rounds'] == 1 and data['model_name'] == 'fake-model'
    assert [i for i in data['issues'] if i['level'] == 'ERROR'] == []
    assert len(fake.seen) == 1
    # 只回结果：库里的草稿还是空的
    d = ok(client.get(f'/sys/workflow/definitions/{pk}', headers=token_headers))
    assert not (d.get('form') or {}).get('fields'), d.get('form')
    (row,) = _calls(pk)
    assert row['kind'] == 'design' and row['status'] == 'done' and row['rounds'] == 1
    assert row['model'] == 'fake-model' and row['prompt_tokens'] == 100
    assert row['prompt_version'] == ai_design_service.PROMPT_VERSION


def test_publish_errors_are_fed_back_once(client: TestClient, token_headers: dict[str, str], model: Any) -> None:
    """第一次少了兜底分支 → 问题原样回给模型 → 第二次修好了，用第二次的"""
    pk = _definition(client, token_headers, 'PYTEST_AID_REPAIR')
    broken = _copy(model__root__next__branches__1__default=False)
    fake = model(broken, PURCHASE)
    data = ok(_generate(client, token_headers, pk))
    assert data['rounds'] == 2
    assert [i for i in data['issues'] if i['level'] == 'ERROR'] == []
    feedback = fake.seen[1][-1]['content']
    assert 'CONDITION_NO_DEFAULT' in feedback and 'nodeId=by_total' in feedback, feedback
    assert _calls(pk)[0]['rounds'] == 2


def test_a_worse_repair_falls_back_to_the_first_answer(
    client: TestClient, token_headers: dict[str, str], model: Any
) -> None:
    """修一轮反而连形状都不对了：回第一次那份（带着它的问题，界面上能定位），不回修坏的"""
    pk = _definition(client, token_headers, 'PYTEST_AID_WORSE')
    broken = _copy(model__root__next__branches__1__default=False)
    model(broken, {'form': {'fields': [{'id': '1bad', 'type': 'text', 'label': 'x'}]}, 'model': {}})
    data = ok(_generate(client, token_headers, pk))
    assert data['model']['root']['next']['id'] == 'by_total'
    assert any(i['code'] == 'CONDITION_NO_DEFAULT' and i.get('nodeId') == 'by_total' for i in data['issues'])


def test_a_shape_that_never_validates_is_never_returned(
    client: TestClient, token_headers: dict[str, str], model: Any
) -> None:
    """🔴 两次形状都不对：报错、草稿不动、记一行失败 —— 绝不把形状错的树回给设计器"""
    pk = _definition(client, token_headers, 'PYTEST_AID_SHAPE')
    bad = {'form': {'fields': [{'id': 'x', 'type': 'spreadsheet', 'label': 'x'}]}, 'model': PURCHASE['model']}
    fake = model(bad, '对不起，我做不到')
    res = _generate(client, token_headers, pk)
    assert res.status_code == 400, res.text
    assert 'form.fields.0.type' in fake.seen[1][-1]['content'], '形状错误要具体到路径回给模型'
    (row,) = _calls(pk)
    assert row['status'] == 'failed' and row['rounds'] == 2 and row['error']


def test_made_up_role_ids_are_dropped_and_left_for_a_human(
    client: TestClient, token_headers: dict[str, str], model: Any
) -> None:
    """模型编的角色 ID 丢掉 → 「没配审批人」指到那个节点；这条不回喂（回喂只会逼它再编一个）"""
    pk = _definition(client, token_headers, 'PYTEST_AID_ROLE')
    made_up = _copy(model__root__next__branches__0__child__assignee={'kind': 'role', 'role_ids': ['123456789']})
    fake = model(made_up)
    data = ok(_generate(client, token_headers, pk))
    assert data['model']['root']['next']['branches'][0]['child']['assignee']['role_ids'] == []
    assert any(i['code'] == 'APPROVER_EMPTY' and i.get('nodeId') == 'cfo' for i in data['issues']), data['issues']
    assert len(fake.seen) == 1, '没配审批人不回喂'


def test_unbalanced_json_is_sent_back_with_the_parser_error(
    client: TestClient, token_headers: dict[str, str], model: Any
) -> None:
    """真模型少过一个 `}`：不替它补（补在末尾可能是另一棵树），把解析器的原话回给它修"""
    pk = _definition(client, token_headers, 'PYTEST_AID_JSON')
    text = json.dumps(PURCHASE, ensure_ascii=False)
    fake = model(text[:-1], PURCHASE)
    data = ok(_generate(client, token_headers, pk))
    assert data['rounds'] == 2
    assert 'JSON 解析失败' in fake.seen[1][-1]['content'] and 'char' in fake.seen[1][-1]['content']


def test_a_real_role_id_from_the_list_is_kept(client: TestClient, token_headers: dict[str, str], model: Any) -> None:
    """先断言「有」：清单里的角色要留下（模型拿到的清单就是这些）"""
    pk = _definition(client, token_headers, 'PYTEST_AID_ROLE_OK')
    fake = model(PURCHASE)  # 先跑一次拿到给模型的角色清单
    ok(_generate(client, token_headers, pk))
    listing = fake.seen[0][1]['content']
    roles = json.loads(listing[listing.index('[') : listing.index(']') + 1])
    assert roles, '测试库里应该有角色'
    rid = roles[0]['id']
    model(_copy(model__root__next__branches__0__child__assignee={'kind': 'role', 'role_ids': [rid]}))
    data = ok(_generate(client, token_headers, pk))
    assert data['model']['root']['next']['branches'][0]['child']['assignee']['role_ids'] == [rid]


def test_a_model_that_hangs_fails_visibly(
    client: TestClient, token_headers: dict[str, str], model: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ai_design_service, 'ROUND_TIMEOUT', 0.2)
    pk = _definition(client, token_headers, 'PYTEST_AID_SLOW')
    model(PURCHASE, delay=2)
    res = _generate(client, token_headers, pk)
    assert res.status_code == 400 and '太久' in res.json()['msg'], res.text
    (row,) = _calls(pk)
    assert row['status'] == 'failed'


def test_a_gateway_error_is_recorded_too(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """网关报的错（401 / 429…）是业务异常：原来直接往外抛、跳过了记录 —— 失败的调用最要留痕"""
    pk = _definition(client, token_headers, 'PYTEST_AID_GATEWAY')

    class _Down:
        model = 'fake-model'

        async def stream_chat(self, *_: Any, **__: Any) -> Any:
            raise errors.ServerError(msg='模型网关拒绝了请求（429）：请求太频繁')
            yield  # pragma: no cover —— 让它是个异步生成器

    async def build(_db: Any) -> _Down:  # ruff: ignore[unused-async] —— 顶掉的原函数是 async
        return _Down()

    monkeypatch.setattr(ai_design_service, 'build_client', build)
    res = _generate(client, token_headers, pk)
    assert res.status_code == 400 and '429' in res.json()['msg'], res.text
    (row,) = _calls(pk)
    assert row['status'] == 'failed' and '429' in row['error']
