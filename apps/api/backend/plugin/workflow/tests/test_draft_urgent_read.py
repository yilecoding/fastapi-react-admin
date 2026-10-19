"""发起草稿 · 加急 · 办理人已读"""

from collections.abc import Callable

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_ops import FORM, _detail, _start
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def test_draft_roundtrip_is_private_and_cleared_on_submit(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_DRAFT',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    me = login('sunqiang')
    assert ok(client.get('/sys/workflow/drafts/PYTEST_DRAFT', headers=me)) is None
    # 填到一半就存：不校验（必填没填也能存）
    ok(client.put('/sys/workflow/drafts/PYTEST_DRAFT', headers=me, json={'form': {'f': '写了一半'}}))
    ok(client.put('/sys/workflow/drafts/PYTEST_DRAFT', headers=me, json={'form': {'f': '写了一大半'}}))
    assert ok(client.get('/sys/workflow/drafts/PYTEST_DRAFT', headers=me))['form'] == {'f': '写了一大半'}
    assert 'PYTEST_DRAFT' in {d['code'] for d in ok(client.get('/sys/workflow/drafts', headers=me))}
    # 别人看不到我的草稿
    assert ok(client.get('/sys/workflow/drafts/PYTEST_DRAFT', headers=login('zhoumin'))) is None
    # 太大不收
    big = client.put('/sys/workflow/drafts/PYTEST_DRAFT', headers=me, json={'form': {'f': 'x' * 300_000}})
    assert big.json()['code'] == 400
    # 提交成功：草稿删掉
    ok(
        client.post(
            '/sys/workflow/instances', headers=me, json={'code': 'PYTEST_DRAFT', 'form': {'f': '交了'}, 'key': key()}
        )
    )
    assert ok(client.get('/sys/workflow/drafts/PYTEST_DRAFT', headers=me)) is None


def test_urgent_goes_to_the_top_of_the_todo_list(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_URGENT',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    urgent = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_URGENT', 'form': {'f': '急'}, 'key': key(), 'urgent': True},
        )
    )['instance_id']
    normal = _start(client, login, 'PYTEST_URGENT')  # 后发起的普通单
    rows = ok(client.get('/sys/workflow/inbox/todo', headers=login('zhaolei'), params={'size': 100}))['items']
    ids = [r['id'] for r in rows]
    assert urgent in ids and normal in ids
    # 加急的排在后发起的普通单前面
    assert ids.index(urgent) < ids.index(normal)
    assert next(r for r in rows if r['id'] == urgent)['urgent'] is True


def test_assignee_read_time(client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_READ',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    pk = _start(client, login, 'PYTEST_READ')

    def read_time() -> str | None:
        return next(t for t in _detail(client, login('sunqiang'), pk)['tasks'] if t['node_id'] == 'n1')['read_time']

    assert read_time() is None
    # 别人「已读」不算数
    ok(client.put(f'/sys/workflow/instances/{pk}/read', headers=login('sunqiang')))
    assert read_time() is None
    ok(client.put(f'/sys/workflow/instances/{pk}/read', headers=login('zhaolei')))
    first = read_time()
    assert first is not None
    # 只记第一次
    ok(client.put(f'/sys/workflow/instances/{pk}/read', headers=login('zhaolei')))
    assert read_time() == first
