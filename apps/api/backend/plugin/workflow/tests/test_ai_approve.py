"""AI 自动同意（#111 第 5 条）：只同意不驳回 · 按数据放闸 · 只在提交后没人动过时做 · 关掉立刻停 · 不给自己打分。

模型和 Celery 换成假的（同 `test_ai_review.py`）。放闸的数据（`pass_record`）除了专门测口径的那条，都直接给定 ——
要攒够 30 张有结论的单才能测一次「放闸」，那是在测耐心不是测逻辑。
"""

import asyncio
import json

from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.app.task.celery import celery_app
from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.workflow.engine.flow import validate_publish
from backend.plugin.workflow.service import ai_approve_service, ai_review_service
from backend.plugin.workflow.tests.conftest import ok
from backend.plugin.workflow.tests.test_ai_review import FORM, POINTS, Login, Uid, _FakeClient, _start
from backend.plugin.workflow.tests.test_ops import _act, _detail
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model
from backend.plugin.workflow.tests.test_timeouts import _no_push  # ruff: ignore[unused-import] —— autouse fixture

AI = {'enabled': True, 'minSamples': 30, 'minPrecision': 0.95}


def _reply(verdict: str) -> str:
    return json.dumps({'verdict': verdict, 'reasons': [{'field_id': None, 'text': '理由'}]}, ensure_ascii=False)


def _flow(uid: Uid, *, ai: dict | None = AI) -> dict:
    second = _approval('n2', {'kind': 'user', 'user_ids': [uid('wangfang')]})
    second['aiApprove'] = ai
    first = _approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, nxt=second)
    first['aiApprove'] = ai
    model = _model(first)
    model['aiReview'] = {'enabled': True, 'points': POINTS}
    return model


def _define(client: TestClient, admin: dict[str, str], code: str, model: dict) -> str:
    """建或改（同一个编码再发一版）。返回定义 ID"""
    rows = ok(client.get('/sys/workflow/definitions', headers=admin, params={'name': code}))
    hit = [d for d in rows if d['code'] == code]
    if hit:
        pk = str(hit[0]['id'])
        ok(client.put(f'/sys/workflow/definitions/{pk}', headers=admin, json={'form': FORM, 'model': model}))
    else:
        pk = str(
            ok(
                client.post(
                    '/sys/workflow/definitions',
                    headers=admin,
                    json={'code': code, 'name': code, 'form': FORM, 'model': model},
                )
            )['id']
        )
    assert ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=admin))['published']
    return pk


def _after(review_id: int) -> str:
    async def go() -> str:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            return await ai_approve_service.after_review(create_database_async_session(engine), review_id)
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """派发出去的 review ID（同 `test_ai_review.py`）"""
    out: list[int] = []
    monkeypatch.setattr(celery_app, 'send_task', lambda name, args: out.append(args[0]))
    return out


@pytest.fixture
def model_reply(monkeypatch: pytest.MonkeyPatch) -> Any:
    def set_reply(reply: str) -> _FakeClient:
        fake = _FakeClient(reply)

        async def build(_db: Any) -> _FakeClient:  # ruff: ignore[unused-async] —— 顶掉的原函数是 async
            return fake

        monkeypatch.setattr(ai_review_service, '_build_client', build)
        return fake

    return set_reply


@pytest.fixture
def data(monkeypatch: pytest.MonkeyPatch) -> Any:
    """给定放闸看的数据：（建议通过且有结论的单数，其中通过的）"""

    def set_data(samples: int, approved: int) -> None:
        async def fake(_db: Any, *, code: str, model: str | None) -> tuple[int, int]:  # ruff: ignore[unused-async]
            return samples, approved

        monkeypatch.setattr(ai_approve_service, 'pass_record', fake)

    return set_data


def _current(client: TestClient, admin: dict[str, str], pk: str) -> list[str]:
    return sorted({tk['node_id'] for tk in _detail(client, admin, pk)['tasks'] if tk['status'] == 'pending'})


def test_approves_when_the_data_is_good_enough(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
) -> None:
    """🔴 替这一步同意：人的待办取消（不是「替赵磊同意」，他的「我已审批」里不该有它），记一条 actor_type = ai 的记录"""
    _define(client, token_headers, 'PYTEST_AIA_OK', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_OK')
    model_reply(_reply('pass'))
    data(40, 39)
    assert _after(sent[-1]) == 'pass:approved'

    d = _detail(client, token_headers, pk)
    assert _current(client, token_headers, pk) == ['n2'], '只同意了 n1 这一步，n2 照常给人'
    rec = [r for r in d['records'] if r['action'] == 'ai_approve']
    assert len(rec) == 1 and rec[0]['actor_type'] == 'ai' and rec[0]['actor_name'] == 'fake-model', rec
    assert rec[0]['detail']['samples'] == 40 and rec[0]['detail']['precision'] == pytest.approx(0.975)
    assert '39' not in rec[0]['opinion'] and '97.5%' in rec[0]['opinion'], rec[0]['opinion']
    n1 = [tk for tk in d['tasks'] if tk['node_id'] == 'n1']
    assert n1 and all(tk['status'] == 'canceled' for tk in n1), n1
    done = ok(client.get('/sys/workflow/inbox/done', headers=login('zhaolei'), params={'keyword': 'PYTEST_AIA_OK'}))
    assert all(i['id'] != pk for i in done['items']), '赵磊没同意过，他的「我已审批」里不该有这张单'


@pytest.mark.parametrize('verdict', ['attention', 'reject'])
def test_never_acts_unless_the_review_says_pass(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
    verdict: str,
) -> None:
    """🔴 永远不自动驳回：建议驳回 / 需要留意，数据再好也什么都不做"""
    _define(client, token_headers, 'PYTEST_AIA_NEVER', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_NEVER')
    model_reply(_reply(verdict))
    data(1000, 1000)
    assert _after(sent[-1]) == verdict
    d = _detail(client, token_headers, pk)
    assert d['instance']['status'] == 'running' and _current(client, token_headers, pk) == ['n1']
    assert not [r for r in d['records'] if r['actor_type'] == 'ai']


@pytest.mark.parametrize(('samples', 'approved'), [(29, 29), (40, 37)])
def test_the_gate_holds_until_the_data_is_good_enough(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
    samples: int,
    approved: int,
) -> None:
    """样本不够（29 < 30）/ 准确率不够（37/40 = 92.5% < 95%）：开关开着也照常给人"""
    _define(client, token_headers, 'PYTEST_AIA_GATE', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_GATE')
    model_reply(_reply('pass'))
    data(samples, approved)
    assert _after(sent[-1]) == 'pass:gate'
    assert _current(client, token_headers, pk) == ['n1']


def test_a_review_of_content_someone_has_since_acted_on_is_not_used(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
) -> None:
    """预审还没回来赵磊就同意了，单子到了 n2（n2 也开了自动同意）：那份预审审的是提交时的状态，不能拿来替王芳同意"""
    _define(client, token_headers, 'PYTEST_AIA_MOVED', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_MOVED')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    model_reply(_reply('pass'))
    data(1000, 1000)
    assert _after(sent[-1]) == 'pass:moved'
    assert _current(client, token_headers, pk) == ['n2']


def test_turning_it_off_and_republishing_stops_in_flight_requests(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
) -> None:
    """在途的单按发起时的快照走 —— 但自动同意还要看**现在发布的版本**也开着：关掉再发布，立刻对在途的单生效"""
    _define(client, token_headers, 'PYTEST_AIA_OFF', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_OFF')
    _define(client, token_headers, 'PYTEST_AIA_OFF', _flow(uid, ai={**AI, 'enabled': False}))
    model_reply(_reply('pass'))
    data(1000, 1000)
    assert _after(sent[-1]) == 'pass:node_off'
    assert _current(client, token_headers, pk) == ['n1']


def test_the_global_switch(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _define(client, token_headers, 'PYTEST_AIA_GLOBAL', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_GLOBAL')
    model_reply(_reply('pass'))
    data(1000, 1000)
    monkeypatch.setattr(settings, 'WORKFLOW_AI_APPROVE_ENABLED', False)
    assert _after(sent[-1]) == 'pass:off'
    assert _current(client, token_headers, pk) == ['n1']


def test_pass_record_counts_like_the_agreement_drawer_and_skips_what_the_ai_decided(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid, sent: list[int], model_reply: Any
) -> None:
    """放闸的口径 = 一致率抽屉的口径（每张单最后一次 done 的预审 · 只算有结论的），而且 AI 自动同意过的单不算 ——
    算进去就是 AI 给自己打分：自动同意得越多，「准确率」越高"""
    code = 'PYTEST_AIA_COUNT'
    _define(client, token_headers, code, _flow(uid))
    zhaolei, wangfang = login('zhaolei'), login('wangfang')

    def submit(verdict: str) -> str:
        pk = _start(client, login, code)
        model_reply(_reply(verdict))
        ai_approve_service_run = _after  # 用同一条路（数据不够时它只是预审）
        assert ai_approve_service_run(sent[-1]).startswith(verdict)
        return pk

    def both_approve(pk: str) -> None:
        ok(_act(client, zhaolei, pk, 'approve'))
        ok(_act(client, wangfang, pk, 'approve'))

    a = submit('pass')
    both_approve(a)  # 建议通过 → 通过
    b = submit('pass')
    ok(_act(client, zhaolei, b, 'reject', opinion='不行'))  # 建议通过 → 驳回
    c = submit('attention')
    both_approve(c)  # 需要留意：不算
    submit('pass')  # 还在审：不算

    async def record() -> tuple[int, int]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                return await ai_approve_service.pass_record(db, code=code, model='fake-model')
        finally:
            await engine.dispose()

    assert asyncio.run(record()) == (2, 1)

    # 现在让 AI 自动同意一张、再让人走完：这张通过了，但不能算进「人最后也通过了」
    real = ai_approve_service.pass_record

    async def plenty(_db: Any, *, code: str, model: str | None) -> tuple[int, int]:  # ruff: ignore[unused-async]
        return 1000, 1000

    ai_approve_service.pass_record = plenty
    try:
        d = _start(client, login, code)
        model_reply(_reply('pass'))
        assert _after(sent[-1]) == 'pass:approved'
    finally:
        ai_approve_service.pass_record = real
    ok(_act(client, wangfang, d, 'approve'))
    assert _detail(client, token_headers, d)['instance']['status'] == 'approved'
    assert asyncio.run(record()) == (2, 1), 'AI 自动同意过的单不能算进放闸的数据'
    stats = ok(client.get('/sys/workflow/monitor/ai-review-stats', headers=token_headers))
    row = next(r for r in stats if r['code'] == code)
    assert row['pass_approved'] == 1, '一致率抽屉同一个口径'


def test_publish_rules() -> None:
    """只能配在或签上（会签 / 依次审批 AI 一票定不了这一步）；依据是预审，没开预审不许开"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f', 'type': 'text', 'label': '事由'}]}
    node = {
        'type': 'approval',
        'id': 'n1',
        'name': '主管',
        'mode': 'all',
        'assignee': {'kind': 'initiator'},
        'aiApprove': AI,
    }
    model = {'schemaVersion': 1, 'root': {'type': 'start', 'id': 'start', 'next': node}}
    codes = {i['code'] for i in validate_publish(form, model) if i['level'] == 'ERROR'}
    assert codes == {'AI_APPROVE_MODE', 'AI_APPROVE_NEEDS_REVIEW'}, codes
    node['mode'] = 'any'
    model['aiReview'] = {'enabled': True, 'points': ''}
    assert not [
        i for i in validate_publish(form, model) if i['level'] == 'ERROR' and i['code'].startswith('AI_APPROVE')
    ]


def test_a_retried_review_can_still_approve(
    client: TestClient,
    token_headers: dict[str, str],
    login: Login,
    uid: Uid,
    sent: list[int],
    model_reply: Any,
    data: Any,
) -> None:
    """预审第一次超时 / 失败、点了重试：重试审的还是同一次提交。

    原来新的那一行没带版本号，「建议通过」也永远不会自动同意
    """
    from backend.common.exception import errors as errs

    _define(client, token_headers, 'PYTEST_AIA_RETRY', _flow(uid))
    pk = _start(client, login, 'PYTEST_AIA_RETRY')
    model_reply(errs.ServerError(msg='网关抖了一下'))
    assert _after(sent[-1]) == 'failed'
    ok(client.post(f'/sys/workflow/instances/{pk}/ai-review/retry', headers=login('zhaolei')))
    model_reply(_reply('pass'))
    data(40, 40)
    assert _after(sent[-1]) == 'pass:approved'
    assert _current(client, token_headers, pk) == ['n2']
