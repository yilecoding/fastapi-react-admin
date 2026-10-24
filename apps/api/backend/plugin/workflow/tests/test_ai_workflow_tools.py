"""在对话里审批（#111 第 4 条）：`plugin/workflow/ai_tools.py` 经 AI 的 dispatcher 走一遍。

会静默出错的几处，每条一个用例：

- **非员工审批人被 `is_staff` 那道闸挡在外面**：审批中心刻意不走 RBAC，照搬写工具的闸门就成了「只有员工能在对话里审批」
- **隐藏字段经 AI 漏出去**：工具要是自己写查询，摘要 / 字段里会带上审批人看不到的值
- **意见被模型自拟**：没给意见也照样驳回、意见不是用户说过的话，或者确认卡片上看不到将要提交的原文
- **这张单不归你办**：要在弹确认卡片之前就说清楚，不是点了确认才报错
- **`act()` 进来先回滚会话上的事务**：同一个会话里 AI 的审计行不能被它一起冲掉

真实测试库 + 真实 Redis，写操作和网页确认后一样提交（`chat_service.confirm_tool` 的做法），
由本插件的 conftest 整模块清理。
"""

import asyncio
import uuid

from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import RedisCli
from backend.plugin.ai.core import dispatcher as dispatcher_module
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import load_builtin_tools
from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_ops import _detail
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish
from backend.plugin.workflow.tests.test_timeouts import (  # ruff: ignore[unused-import] —— _no_push 是 autouse fixture
    _no_push,
)

FORM = {
    'schemaVersion': 1,
    'fields': [
        {'id': 'f', 'type': 'text', 'label': '事由'},
        {'id': 'f_secret', 'type': 'number', 'label': '内部预算'},
    ],
}


@pytest.fixture(autouse=True)
def _tools() -> None:
    load_builtin_tools()


def _person(pk: str, nickname: str) -> Any:
    """一个**非员工**（`is_staff=False`）、没有任何业务权限码的普通账号 —— 审批人大多就是这样"""
    role = SimpleNamespace(
        status=1, menus=[SimpleNamespace(id=1, perms=None, status=1)], is_filter_scopes=False, scopes=[]
    )
    return SimpleNamespace(
        id=int(pk), nickname=nickname, dept_id=None, is_superuser=False, is_staff=False, roles=[role]
    )


def _setup(client: TestClient, admin: dict[str, str], uid: Any, code: str) -> None:
    model = _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, perms={'f_secret': 'hidden'}))
    _publish(client, admin, code, FORM, model)


def _start(client: TestClient, login: Any, code: str, reason: str = '去上海见客户') -> str:
    body = {'code': code, 'form': {'f': reason, 'f_secret': 98765}, 'key': key()}
    return ok(client.post('/sys/workflow/instances', headers=login('sunqiang'), json=body))['instance_id']


def _run(
    monkeypatch: pytest.MonkeyPatch, user: Any, calls: list[tuple[str, dict, bool]], said: list[str] | None = None
) -> tuple[list[Any], int]:
    """按顺序调工具（`(工具名, 参数, 是否已确认)`）；已确认的那次之后像网页确认一样提交。返回（结果们, 会话 ID）

    `said` 是用户在这段对话里说过的话（网页对话由 `chat_service` 从历史里填）"""
    conversation_id = int(uuid.uuid4().int % 10**15)

    async def main() -> list[Any]:
        redis = RedisCli()
        monkeypatch.setattr(dispatcher_module, 'redis_client', redis)
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            outcomes = []
            for name, args, approved in calls:
                async with create_database_async_session(engine)() as db:
                    ctx = RunContext(user=user, conversation_id=conversation_id, db=db, provider=None, user_said=said)
                    call = ToolCallRequest(call_id=uuid.uuid4().hex, name=name, arguments=args)
                    outcomes.append(await tool_dispatcher.dispatch(call, ctx, pre_approved=approved))
                    await db.commit()
            return outcomes
        finally:
            await engine.dispose()
            await redis.aclose()

    return asyncio.run(main()), conversation_id


def _audits(conversation_id: int) -> list[tuple[str, int]]:
    async def go() -> list[tuple[str, int]]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as s:
                rows = await s.execute(
                    text('SELECT tool_name, status FROM ai_tool_invocation WHERE conversation_id = :c ORDER BY id'),
                    {'c': conversation_id},
                )
                return [(r[0], r[1]) for r in rows]
        finally:
            await engine.dispose()

    return asyncio.run(go())


def test_a_non_staff_approver_can_approve_in_chat(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 普通员工（非 is_staff）看得到、调得动审批工具；别的写工具对他照样不可见（闸门只对登记过的工具开）"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_OK')
    pk = _start(client, login, 'PYTEST_AIWF_OK')
    zhaolei = _person(uid('zhaolei'), '赵磊')

    visible = {s.name for s in tool_dispatcher.visible_tools(zhaolei)}
    assert {'wf_todo_list', 'wf_approve', 'wf_reject', 'wf_transfer'} <= visible
    assert 'dept_create' not in visible, '别的写工具不该因为这次改动对非员工放开'

    (todo, staged, done), conv = _run(
        monkeypatch,
        zhaolei,
        [
            ('wf_todo_list', {}, False),
            ('wf_approve', {'instance_id': pk, 'opinion': '同意'}, False),
            ('wf_approve', {'instance_id': pk, 'opinion': '同意'}, True),
        ],
        said=['把孙强那张同意了，意见写「同意」'],
    )
    assert todo.kind == 'ok' and pk in todo.payload, todo
    assert staged.kind == 'confirm_required', staged
    assert staged.preview.startswith('将以你本人的身份同意「'), staged.preview
    assert done.kind == 'ok', done

    detail = _detail(client, token_headers, pk)
    assert detail['instance']['status'] == 'approved'
    approve = [r for r in detail['records'] if r['action'] == 'approve']
    assert approve and approve[-1]['actor_name'] == '赵磊', '执行人要是用户本人'
    # `act()` 进来会回滚会话上的事务 —— 审计行得还在（它是在工具跑完之后才写的）
    assert ('wf_approve', 0) in _audits(conv), _audits(conv)


def test_hidden_fields_never_reach_the_model(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """审批人看不到「内部预算」：待办摘要和详情工具的输出里都不能有那个值"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_HIDDEN')
    pk = _start(client, login, 'PYTEST_AIWF_HIDDEN')
    (todo, detail), _ = _run(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        [('wf_todo_list', {}, False), ('wf_instance_detail', {'instance_id': pk}, False)],
    )
    assert detail.kind == 'ok', detail
    assert '去上海见客户' in detail.payload, '先断言「有」：可见字段要在'
    for out in (todo.payload, detail.payload):
        assert '98765' not in out and '内部预算' not in out, out


def test_someone_elses_request_is_refused_before_the_confirm_card(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup(client, token_headers, uid, 'PYTEST_AIWF_NOTYOURS')
    pk = _start(client, login, 'PYTEST_AIWF_NOTYOURS')
    (staged,), _ = _run(monkeypatch, _person(uid('wangfang'), '王芳'), [('wf_approve', {'instance_id': pk}, False)])
    assert staged.kind == 'failed' and staged.confirm_token is None, staged
    assert _detail(client, token_headers, pk)['instance']['status'] == 'running'


def test_reject_needs_the_users_own_words(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """驳回意见要用户原话：不给就在预演里拦下；给了，确认卡片上原样显示、提交上去也是原样"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_REJECT')
    pk = _start(client, login, 'PYTEST_AIWF_REJECT')
    words = '事由没写清楚，先补充客户名称'
    (blank, staged, done), _ = _run(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        [
            ('wf_reject', {'instance_id': pk, 'opinion': ' '}, False),
            ('wf_reject', {'instance_id': pk, 'opinion': words}, False),
            ('wf_reject', {'instance_id': pk, 'opinion': words}, True),
        ],
        said=['驳回孙强那张', f'理由：{words}。'],
    )
    assert blank.kind == 'failed' and '原话' in blank.payload, blank
    assert staged.kind == 'confirm_required' and f'「{words}」' in staged.preview, staged
    assert done.kind == 'ok', done
    detail = _detail(client, token_headers, pk)
    assert detail['instance']['status'] == 'rejected'
    assert [r['opinion'] for r in detail['records'] if r['action'] == 'reject'][-1] == words


def test_an_opinion_the_user_never_said_is_refused(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 真模型（Qwen3-VL）在用户没给理由时填了「用户未提供驳回理由」—— 它会以用户本人的名义进审批记录。

    先断言「有」：原话（哪怕只是其中一段、带不带句号）能过；然后编的、改写过的都在预演拦下、不发令牌。
    """
    _setup(client, token_headers, uid, 'PYTEST_AIWF_WORDS')
    pk = _start(client, login, 'PYTEST_AIWF_WORDS')
    said = ['把孙强那张驳回', '理由是事由太笼统']
    outcomes, _ = _run(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        [
            ('wf_reject', {'instance_id': pk, 'opinion': '事由太笼统。'}, False),
            ('wf_reject', {'instance_id': pk, 'opinion': '用户未提供驳回理由'}, False),
            ('wf_reject', {'instance_id': pk, 'opinion': '申请事由描述不够具体'}, False),
            ('wf_approve', {'instance_id': pk, 'opinion': '同意，辛苦了'}, False),
        ],
        said=said,
    )
    quoted, made_up, rephrased, approve_made_up = outcomes
    assert quoted.kind == 'confirm_required', quoted
    for o in (made_up, rephrased, approve_made_up):
        assert o.kind == 'failed' and o.confirm_token is None and '原话' in o.payload, o


def test_transfer_by_name(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup(client, token_headers, uid, 'PYTEST_AIWF_TRANSFER')
    pk = _start(client, login, 'PYTEST_AIWF_TRANSFER')
    zhaolei = _person(uid('zhaolei'), '赵磊')
    (unknown, staged, done), _ = _run(
        monkeypatch,
        zhaolei,
        [
            ('wf_transfer', {'instance_id': pk, 'to_user': '查无此人'}, False),
            ('wf_transfer', {'instance_id': pk, 'to_user': '王芳'}, False),
            ('wf_transfer', {'instance_id': pk, 'to_user': '王芳'}, True),
        ],
    )
    assert unknown.kind == 'failed' and '找不到' in unknown.payload, unknown
    assert staged.kind == 'confirm_required' and '王芳（wangfang）' in staged.preview, staged
    assert done.kind == 'ok', done
    # 现在单子在王芳手上：她的待办里有，赵磊的没了
    (mine,), _ = _run(monkeypatch, zhaolei, [('wf_todo_list', {}, False)])
    (hers,), _ = _run(monkeypatch, _person(uid('wangfang'), '王芳'), [('wf_todo_list', {}, False)])
    assert pk in hers.payload and pk not in mine.payload


@pytest.fixture
def namesakes(client: TestClient, token_headers: dict[str, str]) -> Any:
    """21 个昵称**含**「PYTEST同名」的人排在前面，最后建两个昵称**就是**「PYTEST同名」的。用完硬删。

    模糊搜索按 ID 截在 20 条：原来的查法前 20 条全是「PYTEST同名X…」，两个真同名的都被截掉
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    made: list[str] = []
    names = [f'PYTEST同名X{i:02d}' for i in range(21)] + ['PYTEST同名', 'PYTEST同名']
    for i, nickname in enumerate(names):
        body = {
            'username': f'pytest_same_{i:02d}',
            'password': 'Tmp@123456',
            'nickname': nickname,
            'dept_id': dept_id,
            'roles': [roles[0]['id']],
        }
        res = client.post('/sys/users', headers=token_headers, json=body)
        assert res.status_code == 200 and res.json()['code'] == 200, res.text
        made.append(str(res.json()['data']['id']))
    yield made

    async def purge() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as s:
                for pk in made:
                    await s.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': int(pk)})
                    await s.execute(text('DELETE FROM sys_user WHERE id = :pk'), {'pk': int(pk)})
        finally:
            await engine.dispose()

    asyncio.run(purge())


def test_two_people_with_the_same_name_are_never_guessed_between(
    client: TestClient,
    token_headers: dict[str, str],
    login: Any,
    uid: Any,
    monkeypatch: pytest.MonkeyPatch,
    namesakes: Any,
) -> None:
    """🔴 重名不猜：哪怕模糊搜索能命中几十个人、两个真同名的排在第 20 条之后"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_SAME')
    pk = _start(client, login, 'PYTEST_AIWF_SAME')
    (staged,), _ = _run(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        [('wf_transfer', {'instance_id': pk, 'to_user': 'PYTEST同名'}, False)],
    )
    assert staged.kind == 'failed' and '对应多个人' in staged.payload, staged
    assert staged.confirm_token is None


def test_punctuation_and_negated_fragments_are_not_the_users_words(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """「。」压完是空串（空串是任何话的子串）；用户说「我不同意」时，「同意」也是它的一段 —— 两种都不能当原话"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_NEG')
    pk = _start(client, login, 'PYTEST_AIWF_NEG')
    outcomes, _ = _run(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        [
            ('wf_approve', {'instance_id': pk, 'opinion': '同意，没问题'}, False),
            ('wf_approve', {'instance_id': pk, 'opinion': '同意'}, False),
            ('wf_reject', {'instance_id': pk, 'opinion': '。'}, False),
        ],
        said=['这张我不同意', '先别同意，没问题的话我自己批'],
    )
    rephrased, negated, blank = outcomes
    # 先断言「有」：同一句里没被否定的那一段照样算（「没问题的话我自己批」里的「我自己批」）
    (ok_words,), _ = _run(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        [('wf_approve', {'instance_id': pk, 'opinion': '我自己批'}, False)],
        said=['先别同意，没问题的话我自己批'],
    )
    assert ok_words.kind == 'confirm_required', ok_words
    for o in (negated, blank):
        assert o.kind == 'failed' and o.confirm_token is None, o
    assert rephrased.kind == 'failed', '「同意，没问题」也不是原话（两句拼的）'


def test_todo_search_takes_several_words(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """本地真跑时模型传的 keyword 是「孙强 苏州 演示：差旅报销」：整串当一个子串永远匹配不上，模型拿到 0 张就放弃了。
    按空格拆开、每个词都要命中；一个都没中时告诉它一共有几张、可以不带 keyword 再查"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_TODO_WORDS')
    pk = _start(client, login, 'PYTEST_AIWF_TODO_WORDS', reason='去苏州见客户')
    zhaolei = _person(uid('zhaolei'), '赵磊')
    (several, none), _ = _run(
        monkeypatch,
        zhaolei,
        [
            ('wf_todo_list', {'keyword': '孙强 苏州 PYTEST_AIWF_TODO_WORDS'}, False),
            ('wf_todo_list', {'keyword': '北京'}, False),
        ],
    )
    assert pk in several.payload, several.payload
    assert '"total": 0' in none.payload and '不带 keyword' in none.payload, none.payload
