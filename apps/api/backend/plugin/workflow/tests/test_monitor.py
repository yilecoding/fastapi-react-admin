"""实例监控：筛选（流程 / 发起人 / 发起时间）+ 当前卡在谁手上"""

from collections.abc import Callable

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import ok
from backend.plugin.workflow.tests.test_ops import FORM, _start
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def test_monitor_filters_and_current_handlers(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_MON',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    def_id = next(
        d['id'] for d in ok(client.get('/sys/workflow/definitions', headers=token_headers)) if d['code'] == 'PYTEST_MON'
    )
    mine = _start(client, login, 'PYTEST_MON', who='sunqiang')
    other = _start(client, login, 'PYTEST_MON', who='zhoumin')

    def ids(**params: str) -> list[str]:
        return [
            r['id']
            for r in ok(client.get('/sys/workflow/monitor', headers=token_headers, params={'size': 100, **params}))[
                'items'
            ]
        ]

    by_def = ids(definition_id=def_id)
    assert mine in by_def and other in by_def
    # 发起人按姓名或用户名都能找
    assert mine in ids(definition_id=def_id, initiator='孙强') and other not in ids(
        definition_id=def_id, initiator='孙强'
    )
    assert other in ids(definition_id=def_id, initiator='zhoumin')
    # 发起时间：未来的区间里没有
    assert ids(definition_id=def_id, start_time='2999-01-01 00:00:00') == []
    # 卡在谁手上
    row = next(
        r
        for r in ok(
            client.get('/sys/workflow/monitor', headers=token_headers, params={'definition_id': def_id, 'size': 100})
        )['items']
        if r['id'] == mine
    )
    assert row['current_node_name'] == 'n1' and len(row['handlers']) == 1
