"""系统意见（自动驳回 / 自动跳过 / 超时自动处理 …）按**读的人**的语言显示，不按触发那一刻的语言。

修之前：`t('workflow.no_assignee_reject', node=…)` 的结果直接当 `opinion` 落库 —— 英文界面的人发起、
撞上自动驳回，这条记录就永远是英文；中文界面的仪表盘「我发起的」里中英混排。超时 / AI 自动同意在 Celery
里跑，没有请求上下文，永远落默认语言（中文）。

现在落库时另存「消息键 + 参数」（`opinion_i18n`），读的时候按当前请求的语言渲染；
`opinion` 列照旧存一份文本（默认语言），老数据（`opinion_i18n` 为空）原样返回。
"""

import asyncio

from collections.abc import Callable
from typing import Any

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.workflow.tests.conftest import ok
from backend.plugin.workflow.tests.test_ops import FORM, _start
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish
from backend.plugin.workflow.tests.test_runtime import leave_form, start
from backend.plugin.workflow.tests.test_timeouts import (  # ruff: ignore[unused-import] —— _no_push 是 autouse fixture
    _no_push,
    _run,
)

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]

ZH = {'Accept-Language': 'zh-CN'}
EN = {'Accept-Language': 'en-US'}


def _detail(client: TestClient, headers: dict[str, str], pk: str) -> dict[str, Any]:
    return ok(client.get(f'/sys/workflow/instances/{pk}', headers=headers))


def _auto_reject(d: dict[str, Any]) -> dict[str, Any]:
    return next(r for r in d['records'] if r['action'] == 'auto_reject')


def _initiated_last(client: TestClient, headers: dict[str, str], pk: str) -> dict[str, Any]:
    """「我发起的」（仪表盘卡片用的是 progress=true 这一路）里这张单的 `last`"""
    data = ok(client.get('/sys/workflow/inbox/initiated', headers=headers, params={'progress': True, 'size': 10}))
    return next(r for r in data['items'] if str(r['id']) == str(pk))['last']


def _zh(node: str) -> str:
    return f'「{node}」没有找到审批人，已自动驳回'


def _en(node: str) -> str:
    return f'No approver found for "{node}", rejected automatically'


def _auto_rejected_by_admin(client: TestClient, token_headers: dict[str, str], uid: Uid, lang: dict[str, str]) -> str:
    """admin 在总部、总部没配负责人，「请假」第一步「直属主管」取不到人 → 自动驳回（同 test_runtime）"""
    pk = start(client, {**token_headers, **lang}, leave_form(uid))
    assert _detail(client, token_headers, pk)['instance']['status'] == 'rejected'
    return pk


def test_auto_reject_triggered_in_english_reads_in_chinese(
    client: TestClient, token_headers: dict[str, str], uid: Uid
) -> None:
    pk = _auto_rejected_by_admin(client, token_headers, uid, EN)
    zh = _auto_reject(_detail(client, {**token_headers, **ZH}, pk))
    assert zh['opinion'] == _zh(zh['node_name'])
    # 仪表盘「我发起的」卡片和列表页读的是同一个接口
    assert _initiated_last(client, {**token_headers, **ZH}, pk)['opinion'] == _zh(zh['node_name'])
    # 同一条记录，英文读就是英文
    assert _auto_reject(_detail(client, {**token_headers, **EN}, pk))['opinion'] == _en(zh['node_name'])


def test_auto_reject_triggered_in_chinese_reads_in_english(
    client: TestClient, token_headers: dict[str, str], uid: Uid
) -> None:
    pk = _auto_rejected_by_admin(client, token_headers, uid, ZH)
    en = _auto_reject(_detail(client, {**token_headers, **EN}, pk))
    assert en['opinion'] == _en(en['node_name'])
    assert _initiated_last(client, {**token_headers, **EN}, pk)['opinion'] == _en(en['node_name'])


def test_legacy_plain_text_opinion_is_returned_as_is(
    client: TestClient, token_headers: dict[str, str], uid: Uid
) -> None:
    """修之前落的库：`opinion` 是触发时那个语言的成品文本，没有消息键 —— 照原样返回，不去猜"""
    pk = _auto_rejected_by_admin(client, token_headers, uid, ZH)
    legacy = 'No approver found for "直属主管", rejected automatically'

    async def downgrade() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as s:
                await s.execute(
                    text(
                        'UPDATE wf_action_record SET opinion = :o, opinion_i18n = NULL '
                        "WHERE instance_id = :i AND action = 'auto_reject'"
                    ),
                    {'o': legacy, 'i': int(pk)},
                )
        finally:
            await engine.dispose()

    asyncio.run(downgrade())
    for lang in (ZH, EN):
        assert _auto_reject(_detail(client, {**token_headers, **lang}, pk))['opinion'] == legacy
        assert _initiated_last(client, {**token_headers, **lang}, pk)['opinion'] == legacy


def test_timeout_reject_from_worker_reads_in_the_readers_language(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """超时自动驳回在 Celery 里跑、没有请求语言 —— 修之前永远是中文。待办上的意见和轨迹上的一样要跟着读的人走"""
    node = _approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})
    node['timeout'] = {'hours': 2, 'action': 'reject'}
    _publish(client, token_headers, 'PYTEST_I18N_TO', FORM, _model(node))
    pk = _start(client, login, 'PYTEST_I18N_TO')
    assert _run(3)['reject'] >= 1

    en = _detail(client, {**login('sunqiang'), **EN}, pk)
    assert next(r for r in en['records'] if r['action'] == 'timeout_reject')['opinion'] == (
        'Not handled within 2 hours; rejected automatically'
    )
    assert next(tk for tk in en['tasks'] if tk['node_id'] == 'n1')['opinion'] == (
        'Not handled within 2 hours; rejected automatically'
    )
    zh = _detail(client, {**login('sunqiang'), **ZH}, pk)
    assert (
        next(r for r in zh['records'] if r['action'] == 'timeout_reject')['opinion'] == '超过 2 小时未处理，已自动驳回'
    )
