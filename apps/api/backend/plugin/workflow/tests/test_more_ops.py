"""退回后直达 · 拿回 · 加签"""

from collections.abc import Callable
from typing import Any

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_ops import FORM, _act, _caps, _detail, _start, _todo
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def _chain(
    client: TestClient, admin: dict[str, str], uid: Uid, code: str, *people: str, form: dict | None = None
) -> None:
    """n1 → n2 → …，每一步一个人"""
    nxt: Any = None
    for i in range(len(people), 0, -1):
        nxt = _approval(f'n{i}', {'kind': 'user', 'user_ids': [uid(people[i - 1])]}, nxt=nxt)
    _publish(client, admin, code, form or FORM, _model(nxt))


def _current(client: TestClient, login: Login, pk: str) -> str | None:
    return _detail(client, login('sunqiang'), pk)['instance']['current_node_id']


# ── 退回后直达 ───────────────────────────────────────────────────────────────


def test_resubmit_jumps_straight_back_to_the_step_that_sent_it_back(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _chain(client, token_headers, uid, 'PYTEST_RESUME0', 'zhaolei', 'zhoumin')
    pk = _start(client, login, 'PYTEST_RESUME0')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='start', opinion='补一下', resume=True))
    # 预告也是直达：发起人看到的下一步是周敏，不是赵磊
    assert [s['node_id'] for s in _detail(client, login('sunqiang'), pk)['forecast']] == ['n2']
    ok(_act(client, login('sunqiang'), pk, 'approve', form={'f': '补好了'}))
    assert _current(client, login, pk) == 'n2'
    assert _todo(client, login, 'zhaolei', pk) is None and _todo(client, login, 'zhoumin', pk) is not None
    assert any(r['action'] == 'resume' for r in _detail(client, login('sunqiang'), pk)['records'])
    # 直达只用一次：周敏同意后照常往下走（结束）
    ok(_act(client, login('zhoumin'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


def test_resume_from_an_earlier_step_skips_the_steps_in_between(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _chain(client, token_headers, uid, 'PYTEST_RESUME1', 'zhaolei', 'wangfang', 'zhoumin')
    pk = _start(client, login, 'PYTEST_RESUME1')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('wangfang'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='n1', opinion='再看看', resume=True))
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    # n1 办完直接回到 n3，n2（王芳）不再审一遍
    assert _current(client, login, pk) == 'n3'
    assert _todo(client, login, 'wangfang', pk) is None


def test_resume_does_not_jump_to_a_step_no_longer_on_the_path(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """发起人改了金额，条件分支已经不走退回的那一步了：照常从头走，不能硬跳过去"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f_n', 'type': 'number', 'label': '金额'}]}
    model = _model(
        _approval(
            'n1',
            {'kind': 'user', 'user_ids': [uid('zhaolei')]},
            nxt={
                'type': 'condition',
                'id': 'c1',
                'name': 'c',
                'next': None,
                'branches': [
                    {
                        'id': 'b_big',
                        'name': '大额',
                        'when': {'all': [{'var': 'f_n', 'op': 'gt', 'value': 100}]},
                        'child': _approval('n_big', {'kind': 'user', 'user_ids': [uid('zhoumin')]}),
                    },
                    {'id': 'b_def', 'name': '其他', 'default': True, 'child': None},
                ],
            },
        )
    )
    _publish(client, token_headers, 'PYTEST_RESUME2', form, model)
    pk = _start(client, login, 'PYTEST_RESUME2', form={'f_n': 500})
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='start', opinion='金额不对', resume=True))
    ok(_act(client, login('sunqiang'), pk, 'approve', form={'f_n': 5}))
    assert _current(client, login, pk) == 'n1'
    assert not any(r['action'] == 'resume' for r in _detail(client, login('sunqiang'), pk)['records'])


# ── 拿回 ─────────────────────────────────────────────────────────────────────


def test_take_back_before_the_next_person_acts(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _chain(client, token_headers, uid, 'PYTEST_TAKE0', 'zhaolei', 'zhoumin')
    pk = _start(client, login, 'PYTEST_TAKE0')
    # 还没同意时没有「拿回」
    assert 'take_back' not in _caps(_detail(client, login('zhaolei'), pk))
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    assert 'take_back' in _caps(_detail(client, login('zhaolei'), pk))
    # 别人拿不回
    assert 'take_back' not in _caps(_detail(client, login('sunqiang'), pk))
    ok(_act(client, login('zhaolei'), pk, 'take_back'))
    assert _current(client, login, pk) == 'n1'
    assert _todo(client, login, 'zhaolei', pk) is not None and _todo(client, login, 'zhoumin', pk) is None
    n1 = [x for x in _detail(client, login('sunqiang'), pk)['tasks'] if x['node_id'] == 'n1']
    assert [x['decision'] for x in n1] == ['take_back', None]
    # 拿回之后照常办
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


def test_take_back_is_gone_once_the_next_person_acts(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _chain(client, token_headers, uid, 'PYTEST_TAKE1', 'zhaolei', 'zhoumin', 'chenjing')
    pk = _start(client, login, 'PYTEST_TAKE1')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    # 下一个人动过了（转交也算）：拿不回
    ok(_act(client, login('zhoumin'), pk, 'transfer', target_user_ids=[uid('wangfang')]))
    assert 'take_back' not in _caps(_detail(client, login('zhaolei'), pk))
    assert _act(client, login('zhaolei'), pk, 'take_back').json()['code'] == 409


def test_take_back_in_sequential_keeps_the_queue(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    order = ['zhaolei', 'zhoumin', 'chenjing']
    _publish(
        client,
        token_headers,
        'PYTEST_TAKE2',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid(u) for u in order]}, mode='seq')),
    )
    pk = _start(client, login, 'PYTEST_TAKE2')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('zhaolei'), pk, 'take_back'))
    assert _todo(client, login, 'zhoumin', pk) is None
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    # 队列没乱：还是轮到周敏，然后陈静
    ok(_act(client, login('zhoumin'), pk, 'approve'))
    assert _todo(client, login, 'chenjing', pk) is not None


# ── 加签 ─────────────────────────────────────────────────────────────────────


def test_add_sign_before_comes_back_to_me_after_all_of_them(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _chain(client, token_headers, uid, 'PYTEST_SIGN0', 'zhaolei')
    pk = _start(client, login, 'PYTEST_SIGN0')
    ok(
        _act(
            client,
            login('zhaolei'),
            pk,
            'add_sign',
            sign_mode='before',
            target_user_ids=[uid('wangfang'), uid('chenjing')],
            opinion='请两位先看',
        )
    )
    assert _todo(client, login, 'zhaolei', pk) is None
    # 加签进来的人只能表态，不能再加签 / 退回
    member = _caps(_detail(client, login('wangfang'), pk))
    assert 'approve' in member and not member & {'add_sign', 'send_back'}
    ok(_act(client, login('wangfang'), pk, 'approve'))
    assert _todo(client, login, 'zhaolei', pk) is None  # 陈静还没办
    ok(_act(client, login('chenjing'), pk, 'approve'))
    assert _todo(client, login, 'zhaolei', pk) is not None
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


def test_add_sign_after_on_an_or_node_waits_for_them(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """或签 赵磊 / 周敏：赵磊同意并在之后加签王芳 —— 周敏不用办了，但要等王芳同意才算过"""
    _publish(
        client,
        token_headers,
        'PYTEST_SIGN1',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei'), uid('zhoumin')]})),
    )
    pk = _start(client, login, 'PYTEST_SIGN1')
    ok(_act(client, login('zhaolei'), pk, 'add_sign', sign_mode='after', target_user_ids=[uid('wangfang')]))
    assert _todo(client, login, 'zhoumin', pk) is None
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'running'
    ok(_act(client, login('wangfang'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


def test_add_sign_after_in_sequential_then_next_in_queue(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_SIGN2',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei'), uid('zhoumin')]}, mode='seq')),
    )
    pk = _start(client, login, 'PYTEST_SIGN2')
    ok(_act(client, login('zhaolei'), pk, 'add_sign', sign_mode='after', target_user_ids=[uid('wangfang')]))
    assert _todo(client, login, 'zhoumin', pk) is None
    ok(_act(client, login('wangfang'), pk, 'approve'))
    assert _todo(client, login, 'zhoumin', pk) is not None


def test_add_sign_rejects_bad_targets_and_member_veto_rejects_all(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_SIGN3',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei'), uid('zhoumin')]}, mode='all')),
    )
    pk = _start(client, login, 'PYTEST_SIGN3')
    url_ok = lambda **b: _act(client, login('zhaolei'), pk, 'add_sign', **b).json()['code']  # ruff: ignore[lambda-assignment]
    assert url_ok(target_user_ids=[uid('wangfang')]) == 400  # 没说在前还是在后
    assert url_ok(sign_mode='before', target_user_ids=[uid('sunqiang')]) == 409  # 发起人
    assert url_ok(sign_mode='before', target_user_ids=[uid('zhoumin')]) == 409  # 已经在这一步里
    ok(_act(client, login('zhaolei'), pk, 'add_sign', sign_mode='before', target_user_ids=[uid('wangfang')]))
    ok(_act(client, login('wangfang'), pk, 'reject', opinion='不行'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'rejected'


def test_take_back_an_add_sign(client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid) -> None:
    _chain(client, token_headers, uid, 'PYTEST_SIGN4', 'zhaolei')
    pk = _start(client, login, 'PYTEST_SIGN4')
    ok(_act(client, login('zhaolei'), pk, 'add_sign', sign_mode='before', target_user_ids=[uid('wangfang')]))
    ok(_act(client, login('zhaolei'), pk, 'take_back'))
    assert _todo(client, login, 'wangfang', pk) is None and _todo(client, login, 'zhaolei', pk) is not None
    # 加签组跟着撤掉了：赵磊直接同意就结束，不会再等王芳
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'
    assert key()


def test_take_back_restores_the_resume_jump(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """赵磊的同意用掉了「直达 n3」，他又拿回：再同意时还得直达 —— 拿回要把实例变量一起恢复"""
    _chain(client, token_headers, uid, 'PYTEST_TAKE3', 'zhaolei', 'wangfang', 'zhoumin')
    pk = _start(client, login, 'PYTEST_TAKE3')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('wangfang'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='n1', opinion='再看看', resume=True))
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    assert _current(client, login, pk) == 'n3'
    ok(_act(client, login('zhaolei'), pk, 'take_back'))
    assert _current(client, login, pk) == 'n1' and _todo(client, login, 'zhoumin', pk) is None
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    assert _current(client, login, pk) == 'n3'
