"""独立代码审查发现的问题，每条一个回归测试"""

import asyncio

from collections.abc import Callable
from typing import Any

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.workflow.tests.conftest import key, ok

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def _publish(client: TestClient, admin: dict[str, str], code: str, form: dict, model: dict) -> None:
    pk = ok(
        client.post(
            '/sys/workflow/definitions', headers=admin, json={'code': code, 'name': code, 'form': form, 'model': model}
        )
    )['id']
    res = ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=admin))
    assert res['published'], res


def _approval(nid: str, rule: dict[str, Any], *, mode: str = 'any', perms: dict | None = None, nxt: Any = None) -> dict:
    return {
        'type': 'approval',
        'id': nid,
        'name': nid,
        'mode': mode,
        'assignee': rule,
        'onEmpty': 'reject',
        'fieldPerms': perms or {},
        'next': nxt,
    }


def _model(first: dict) -> dict:
    return {'schemaVersion': 1, 'root': {'type': 'start', 'id': 'start', 'next': first}}


def test_summary_never_contains_fields_hidden_anywhere(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """摘要原样出现在待办 / 抄送列表和通知正文里，不经过按人裁字段 —— 被 hidden 的字段不能进摘要"""
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f_salary', 'type': 'number', 'label': '薪资'},
            {'id': 'f_title', 'type': 'text', 'label': '岗位'},
        ],
    }
    _publish(
        client,
        token_headers,
        'PYTEST_SUMMARY',
        form,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, perms={'f_salary': 'hidden'})),
    )
    ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_SUMMARY', 'form': {'f_salary': 50000, 'f_title': '工程师'}, 'key': key()},
        )
    )
    rows = ok(client.get('/sys/workflow/inbox/todo', headers=login('zhaolei'), params={'keyword': '工程师'}))['items']
    # 先断言「有」：真的在待办里、摘要也真的有内容
    assert len(rows) == 1 and '岗位：工程师' in rows[0]['summary']
    assert '薪资' not in rows[0]['summary'] and '50000' not in rows[0]['summary']
    # 用摘要搜隐藏值也搜不到
    assert (
        ok(client.get('/sys/workflow/inbox/todo', headers=login('zhaolei'), params={'keyword': '50000'}))['items'] == []
    )


def test_cosign_cannot_transfer_to_someone_who_already_approved(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """会签 A/B/C：A 同意后 B 转给 A，A 再同意 —— 三人会签只有两人表态。转给已同意的人要拒绝"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f', 'type': 'text', 'label': 'f'}]}
    ids = [uid('zhaolei'), uid('zhoumin'), uid('chenjing')]
    _publish(
        client,
        token_headers,
        'PYTEST_COSIGN3',
        form,
        _model(_approval('n1', {'kind': 'user', 'user_ids': ids}, mode='all')),
    )
    pk = ok(
        client.post('/sys/workflow/instances', headers=login('sunqiang'), json={'code': 'PYTEST_COSIGN3', 'key': key()})
    )['instance_id']
    url = f'/sys/workflow/instances/{pk}/actions'
    ok(client.post(url, headers=login('zhaolei'), json={'action': 'approve', 'key': key()}))
    resp = client.post(
        url, headers=login('zhoumin'), json={'action': 'transfer', 'key': key(), 'target_user_ids': [uid('zhaolei')]}
    )
    assert resp.json()['code'] == 409, resp.text
    # 先断言「转交本身是好的」：转给节点之外的人照样可以
    ok(
        client.post(
            url,
            headers=login('zhoumin'),
            json={'action': 'transfer', 'key': key(), 'target_user_ids': [uid('wangfang')]},
        )
    )


def _sql(sql: str, **params: Any) -> None:
    async def run() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as s:
                await s.execute(text(sql), params)
        finally:
            await engine.dispose()

    asyncio.run(run())


def _drop_user_cache(user_id: str) -> None:
    """JWT 用户快照（含部门）缓存在 Redis 的 `fba:user:<id>`，直接改库它不会跟着变。

    用一个独立的**同步**连接删，不碰共享的异步客户端（tests 分册「测试里不要 asyncio.run」那条的前提）。
    """
    import redis

    from backend.core.conf import settings

    r = redis.Redis(
        host=settings.REDIS_HOST,
        port=settings.REDIS_PORT,
        password=settings.REDIS_PASSWORD or None,
        db=settings.REDIS_DATABASE,
    )
    try:
        r.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
    finally:
        r.close()


def test_disabled_dept_leader_counts_as_not_configured(client: TestClient, login: Login, uid: Uid) -> None:
    """部门负责人账号停用了：当「没配」往上找，而不是这一级取人为空、走 onEmpty。

    场景：周敏临时挪进后端组，后端组负责人刘洋停用 → 直属主管应是技术中心的张伟。
    修之前：命中后端组、刘洋被过滤掉 → 取人为空 → 「请假」配的 onEmpty=admin，转给了管理员。
    """
    from backend.plugin.workflow.tests.test_runtime import leave_form

    _sql(
        "UPDATE sys_user SET dept_id = (SELECT id FROM sys_dept WHERE code = 'TECH_BE' AND deleted = 0) "
        "WHERE username = 'zhoumin'"
    )
    _sql("UPDATE sys_user SET status = 0 WHERE username = 'liuyang'")
    _drop_user_cache(uid('zhoumin'))
    try:
        steps = ok(
            client.post(
                '/sys/workflow/startable/LEAVE/preview', headers=login('zhoumin'), json={'form': leave_form(uid)}
            )
        )['steps']
        assert steps[0]['node_id'] == 'n_leader'
        assert [u['name'] for u in steps[0]['users']] == ['张伟'], steps[0]
        assert steps[0]['outcome'] == 'ok'
    finally:
        _sql("UPDATE sys_user SET status = 1 WHERE username = 'liuyang'")
        _sql(
            "UPDATE sys_user SET dept_id = (SELECT id FROM sys_dept WHERE code = 'HQ' AND deleted = 0) "
            "WHERE username = 'zhoumin'"
        )
        _drop_user_cache(uid('zhoumin'))


def test_malformed_input_is_400_not_500(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f_amt', 'type': 'amount', 'label': '金额'},
            {'id': 'f_user', 'type': 'user', 'label': '人'},
        ],
    }
    _publish(
        client,
        token_headers,
        'PYTEST_BADINPUT',
        form,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    for bad in (
        {'f_amt': '1e30'},
        {'f_amt': '9' * 30},
        {'f_user': '²'},
        {'f_user': '9' * 20},
        {'f_user': '99999999999999999999'},
    ):
        resp = client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_BADINPUT', 'form': bad, 'key': key()},
        )
        assert resp.status_code == 400 and resp.json()['code'] == 400, (bad, resp.text)
    # 试算吃的是没校验的表单：同样不能 500
    resp = client.post(
        '/sys/workflow/startable/PYTEST_BADINPUT/preview', headers=login('sunqiang'), json={'form': {'f_user': '²'}}
    )
    assert resp.json()['code'] == 200, resp.text
    resp = client.get(
        '/sys/workflow/directory/users', headers=login('sunqiang'), params={'ids': '²,99999999999999999999'}
    )
    assert resp.json()['code'] == 200 and resp.json()['data'] == []


def test_select_on_start_only_required_on_the_path_taken(
    client: TestClient, token_headers: dict[str, str], login: Login
) -> None:
    """自选审批人的节点在走不到的分支上：不要求选人"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f_n', 'type': 'number', 'label': '金额'}]}
    model = _model({
        'type': 'condition',
        'id': 'c1',
        'name': 'c',
        'next': None,
        'branches': [
            {
                'id': 'b_big',
                'name': '大额',
                'when': {'all': [{'var': 'f_n', 'op': 'gt', 'value': 100}]},
                'child': _approval('n_pick', {'kind': 'select_on_start'}),
            },
            {'id': 'b_def', 'name': '其他', 'default': True, 'child': None},
        ],
    })
    _publish(client, token_headers, 'PYTEST_PICKPATH', form, model)
    # 小额：走兜底，不用选人，直接通过
    pk = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_PICKPATH', 'form': {'f_n': 5}, 'key': key()},
        )
    )['instance_id']
    assert (
        ok(client.get(f'/sys/workflow/instances/{pk}', headers=login('sunqiang')))['instance']['status'] == 'approved'
    )
    # 大额：走到自选节点，不选人要拦住
    resp = client.post(
        '/sys/workflow/instances',
        headers=login('sunqiang'),
        json={'code': 'PYTEST_PICKPATH', 'form': {'f_n': 500}, 'key': key()},
    )
    assert resp.json()['code'] == 400


def test_idempotency_key_of_someone_else_is_not_replayed(client: TestClient, login: Login, uid: Uid) -> None:
    from backend.plugin.workflow.tests.test_runtime import leave_form

    k = key()
    ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'LEAVE', 'form': leave_form(uid), 'key': k},
        )
    )
    resp = client.post(
        '/sys/workflow/instances', headers=login('zhoumin'), json={'code': 'LEAVE', 'form': leave_form(uid), 'key': k}
    )
    assert resp.json()['code'] == 409, resp.text


def _detail(client: TestClient, headers: dict[str, str], pk: str) -> dict[str, Any]:
    return ok(client.get(f'/sys/workflow/instances/{pk}', headers=headers))


def test_branch_and_forecast_hidden_when_condition_uses_a_hidden_field(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """「走了『大额』分支」= 说出了金额区间；后面的预告也随金额变。看不到金额的人两样都不给"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f_amt', 'type': 'number', 'label': '金额'}]}
    hide = {'f_amt': 'hidden'}
    model = _model({
        'type': 'condition',
        'id': 'c1',
        'name': 'c',
        'branches': [
            {
                'id': 'b_big',
                'name': '大额',
                'when': {'all': [{'var': 'f_amt', 'op': 'gt', 'value': 100}]},
                'child': _approval('n_big', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, perms=hide),
            },
            {
                'id': 'b_def',
                'name': '其他',
                'default': True,
                'child': _approval('n_small', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, perms=hide),
            },
        ],
        'next': _approval('n_end', {'kind': 'user', 'user_ids': [uid('wangfang')]}),
    })
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=token_headers,
            json={'code': 'PYTEST_CONDHIDE', 'name': 'x', 'form': form, 'model': model},
        )
    )['id']
    res = ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))
    assert res['published'] and any(i['code'] == 'CONDITION_VAR_HIDDEN' for i in res['issues']), res['issues']

    inst = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_CONDHIDE', 'form': {'f_amt': 500}, 'key': key()},
        )
    )['instance_id']
    # 先断言「有」：发起人看得到金额，分支记录 / 分支状态 / 预告都在
    mine = _detail(client, login('sunqiang'), inst)
    assert any(r['action'] == 'branch' for r in mine['records'])
    assert mine['node_state'].get('branch:b_big') == 'taken'
    assert [s['node_id'] for s in mine['forecast']] == ['n_end']
    # 审批人看不到金额：三样都没有
    theirs = _detail(client, login('zhaolei'), inst)
    assert 'f_amt' not in theirs['form_data']
    assert not any(r['action'] == 'branch' for r in theirs['records'])
    assert not any(k.startswith('branch:') for k in theirs['node_state'])
    assert theirs['forecast'] == []


def test_forecast_hides_names_resolved_from_a_hidden_person_field(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    form = {'schemaVersion': 1, 'fields': [{'id': 'f_boss', 'type': 'user', 'label': '指定人'}]}
    model = _model(
        _approval(
            'n1',
            {'kind': 'user', 'user_ids': [uid('zhaolei')]},
            perms={'f_boss': 'hidden'},
            nxt=_approval('n2', {'kind': 'var_user', 'field': 'f_boss'}),
        )
    )
    _publish(client, token_headers, 'PYTEST_VARHIDE', form, model)
    inst = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_VARHIDE', 'form': {'f_boss': uid('wangfang')}, 'key': key()},
        )
    )['instance_id']
    mine = _detail(client, login('sunqiang'), inst)['forecast']
    assert [(s['node_id'], [u['name'] for u in s['users']]) for s in mine] == [('n2', ['王芳'])]
    theirs = _detail(client, login('zhaolei'), inst)['forecast']
    assert [s['node_id'] for s in theirs] == ['n2']
    assert theirs[0]['users'] == [] and theirs[0]['masked'] is True


class _BizHandler:
    biz_type = 'pytest_biz'

    def __init__(self, amount: int) -> None:
        self.amount = amount

    async def snapshot(self, db: Any, biz_id: int | None, form_data: dict[str, Any]) -> Any:
        from backend.plugin.workflow.handler import BizSnapshot

        return BizSnapshot(title=f'业务单 {biz_id}', variables={'amount': self.amount})

    async def assert_start_allowed(self, db: Any, biz_id: int | None, user_id: int) -> None:
        return None

    async def assert_view_allowed(self, db: Any, biz_id: int | None, user_id: int) -> None:
        return None

    async def on_finished(self, db: Any, biz_id: int | None, event: Any) -> None:
        return None


def test_biz_condition_uses_handler_variables(
    client: TestClient, token_headers: dict[str, str], uid: Uid, monkeypatch: Any
) -> None:
    """业务审批没有表单，条件变量来自 `handler.snapshot().variables`。

    修之前：`start_for_biz` 另收一个 `variables` 当表单数据，被表单校验整个滤掉 → 分支永远走兜底。
    ⚠️ 发布校验要求条件变量是表单字段，所以业务流程用**表单 schema 声明变量**（只声明、发起时不填）。
    """
    from backend.plugin.workflow.handler import register_handler, unregister_handler
    from backend.plugin.workflow.model import WfTask
    from backend.plugin.workflow.service import runtime_service
    from backend.plugin.workflow.service.runtime_service import Actor

    async def _noop(*_: Any) -> None:
        await asyncio.sleep(0)

    monkeypatch.setattr(runtime_service, 'workflow_todo_changed', _noop)
    monkeypatch.setattr(runtime_service, 'notification_new', _noop)

    form = {'schemaVersion': 1, 'fields': [{'id': 'amount', 'type': 'number', 'label': '金额'}]}
    model = _model({
        'type': 'condition',
        'id': 'c1',
        'name': 'c',
        'next': None,
        'branches': [
            {
                'id': 'b_big',
                'name': '大额',
                'when': {'all': [{'var': 'amount', 'op': 'gt', 'value': 100}]},
                'child': _approval('n_big', {'kind': 'user', 'user_ids': [uid('zhaolei')]}),
            },
            {
                'id': 'b_def',
                'name': '其他',
                'default': True,
                'child': _approval('n_small', {'kind': 'user', 'user_ids': [uid('zhoumin')]}),
            },
        ],
    })
    unregister_handler('pytest_biz')
    register_handler(_BizHandler(500))
    try:
        pk = ok(
            client.post(
                '/sys/workflow/definitions',
                headers=token_headers,
                json={
                    'code': 'PYTEST_BIZ',
                    'name': 'x',
                    'biz_type': 'pytest_biz',
                    'form': form,
                    'model': model,
                },
            )
        )['id']
        assert ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))['published']

        async def run() -> list[int]:
            from sqlalchemy import select

            engine = create_database_async_engine(get_database_url(unittest=True))
            try:
                maker = create_database_async_session(engine)
                actor = Actor(
                    id=int(uid('sunqiang')), nickname='孙强', dept_id=None, is_superuser=False, perms=frozenset()
                )
                async with maker.begin() as s:
                    inst, _ = await runtime_service.start_for_biz(s, code='PYTEST_BIZ', biz_id=1, actor=actor)
                    iid = inst.id
                async with maker() as s:
                    return list((await s.scalars(select(WfTask.assignee_id).where(WfTask.instance_id == iid))).all())
            finally:
                await engine.dispose()

        assert asyncio.run(run()) == [int(uid('zhaolei'))]
    finally:
        unregister_handler('pytest_biz')
