"""数据变更审计（#260）：拦截层 · 登记表 · 接口 · 守卫。

查审计行、直接动表都走**同步**引擎（`sync_test_db_url`）：不碰共享 Redis 绑的那个事件循环
（`backend/tests` 分册「不要 asyncio.run」）。拦截层挂在 `Session` 类上，同步会话一样会被记 ——
所以「回滚 / 保存点 / 同一事务改两次 / 没 flush 的新建」这些分支直接用同步会话造，不用绕接口。
"""

from __future__ import annotations

import json
import pathlib
import re

from typing import TYPE_CHECKING, Any

import pytest
import sqlalchemy as sa

from sqlalchemy.orm import Session

from backend.app.admin.model import DataChange, Role, User
from backend.common.data_change import capture, registry
from backend.tests.utils.db import sync_test_db_url
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Iterator

    from starlette.testclient import TestClient

_engine: sa.Engine | None = None


def engine() -> sa.Engine:
    global _engine
    if _engine is None:
        _engine = sa.create_engine(sync_test_db_url())
    return _engine


def changes_of(entity: str, entity_id: Any) -> list[dict[str, Any]]:
    with engine().connect() as conn:
        rows = conn.execute(
            sa
            .select(DataChange.__table__)
            .where(DataChange.entity_type == entity, DataChange.entity_id == int(entity_id))
            .order_by(DataChange.created_time, DataChange.id)
        ).mappings()
        return [dict(r) for r in rows]


def field(record: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((c for c in record['changes'] if c['field'] == name), None)


def ids(members: list[dict[str, Any]]) -> list[str]:
    return [str(m['id']) for m in members]


@pytest.fixture(autouse=True)
def _since(client: TestClient) -> Iterator[None]:
    """只删这条测试写出来的审计行（`client` 保证应用已启动、雪花已初始化 —— 同步会话写审计行要用它发 ID）"""
    started = timezone.now()
    yield
    with engine().begin() as conn:
        conn.execute(sa.delete(DataChange.__table__).where(DataChange.created_time >= started))


@pytest.fixture
def temp_role(client: TestClient, token_headers: dict[str, str]) -> Iterator[str]:
    res = client.post(
        '/sys/roles', headers=token_headers, json={'code': 'PYTEST_DC', 'name': '审计测试角色', 'status': 1}
    )
    assert res.json()['code'] == 200, res.text
    pk = next(
        r['id'] for r in client.get('/sys/roles/all', headers=token_headers).json()['data'] if r['code'] == 'PYTEST_DC'
    )
    yield pk
    with engine().begin() as conn:
        conn.execute(sa.text('DELETE FROM sys_role_menu WHERE role_id = :pk'), {'pk': int(pk)})
        conn.execute(sa.text('DELETE FROM sys_user_role WHERE role_id = :pk'), {'pk': int(pk)})
        conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': int(pk)})


# ── 接口路径：五种写法 ───────────────────────────────────────────────────────


def _user_body(detail: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    body = {
        'dept_id': detail['dept_id'],
        'username': detail['username'],
        'nickname': detail['nickname'],
        'email': detail['email'],
        'phone': detail['phone'],
        'roles': [r['id'] for r in detail['roles']],
    }
    body.update(overrides)
    return body


def test_creating_a_user_records_initial_values_roles_and_a_secret_password(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    (record,) = [r for r in changes_of('user', temp_user) if r['action'] == 'create']
    assert record['actor_name'] == 'admin' and record['source'] == 'web'
    assert record['entity_label'] == 'pytest_tmp_writes'
    assert field(record, 'nickname') == {'field': 'nickname', 'label': '昵称', 'new': '临时用户'}
    # 🔴 密码只记「改过」，值（哪怕是哈希）一个字都不进审计表；盐跟着密码变，在忽略列里
    assert field(record, 'password') == {'field': 'password', 'label': '密码', 'secret': True}
    assert 'salt' not in record['fields'] and 'Tmp@123456' not in json.dumps(record['changes'], ensure_ascii=False)
    roles = field(record, 'roles')
    assert roles is not None and len(roles['added']) == 1 and roles['removed'] == []
    assert roles['added'][0]['label']  # 角色名的快照
    dept = field(record, 'dept_id')
    assert dept is not None and dept['new_label']  # 部门名的快照


def test_updating_a_user_records_old_and_new_values_with_the_actor(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    detail = client.get(f'/sys/users/{temp_user}', headers=token_headers).json()['data']
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    old_role = detail['roles'][0]
    new_role = next(r for r in roles if r['id'] != old_role['id'])
    res = client.put(
        f'/sys/users/{temp_user}',
        headers=token_headers,
        json=_user_body(detail, nickname='改过的昵称', roles=[new_role['id']]),
    )
    assert res.json()['code'] == 200, res.text

    (record,) = [r for r in changes_of('user', temp_user) if r['action'] == 'update']
    assert record['actor_name'] == 'admin' and record['source'] == 'web' and record['actor_id']
    assert record['trace_id'] and record['ip']
    assert field(record, 'nickname') == {'field': 'nickname', 'label': '昵称', 'old': '临时用户', 'new': '改过的昵称'}
    roles_change = field(record, 'roles')
    assert roles_change is not None
    assert ids(roles_change['added']) == [str(new_role['id'])]
    assert roles_change['added'][0]['label'] == new_role['name']
    assert ids(roles_change['removed']) == [str(old_role['id'])]
    assert record['fields'] == ',nickname,roles,'


def test_saving_a_user_unchanged_writes_nothing(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """「全删再全插」的角色：提交时比的是净变化，原样保存不该出一条「删了 A、又加了 A」"""
    detail = client.get(f'/sys/users/{temp_user}', headers=token_headers).json()['data']
    before = len(changes_of('user', temp_user))
    assert client.put(f'/sys/users/{temp_user}', headers=token_headers, json=_user_body(detail)).json()['code'] == 200
    assert len(changes_of('user', temp_user)) == before


def test_updating_a_user_no_longer_touches_last_login_time(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """`last_login_time` 原来带 `onupdate`（上游带过来的）：对用户表的任何 UPDATE 都把「上次登录时间」刷成当前时间"""

    def last_login() -> Any:
        with engine().connect() as conn:
            return conn.execute(sa.select(User.last_login_time).where(User.id == int(temp_user))).scalar_one()

    before = last_login()
    detail = client.get(f'/sys/users/{temp_user}', headers=token_headers).json()['data']
    assert (
        client.put(f'/sys/users/{temp_user}', headers=token_headers, json=_user_body(detail, nickname='改一下')).json()[
            'code'
        ]
        == 200
    )
    assert last_login() == before


def test_status_change_carries_enum_labels(client: TestClient, token_headers: dict[str, str], temp_user: str) -> None:
    res = client.put(f'/sys/users/{temp_user}/permissions', headers=token_headers, params={'type': 'status'})
    assert res.json()['code'] == 200, res.text
    (record,) = [r for r in changes_of('user', temp_user) if r['action'] == 'update']
    assert field(record, 'status') == {
        'field': 'status',
        'label': '状态',
        'old': 1,
        'new': 0,
        'old_label': '正常',
        'new_label': '停用',
    }


def test_password_reset_is_a_secret_change_only(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    res = client.put(f'/sys/users/{temp_user}/password', headers=token_headers, json={'password': 'Other@654321'})
    assert res.json()['code'] == 200, res.text
    (record,) = [r for r in changes_of('user', temp_user) if r['action'] == 'update']
    assert record['changes'] == [{'field': 'password', 'label': '密码', 'secret': True}]


def test_logical_delete_is_recorded_as_a_delete(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    assert client.delete(f'/sys/users/{temp_user}', headers=token_headers).json()['code'] == 200
    (record,) = [r for r in changes_of('user', temp_user) if r['action'] == 'delete']
    # 「deleted 从 0 改成 2049…」不是一条有用的记录
    assert record['changes'] == [] and record['entity_label'] == 'pytest_tmp_writes'


def test_creating_a_role_is_recorded_although_create_model_does_not_flush(temp_role: str) -> None:
    """🔴 角色的 `create_model` 不 flush，INSERT 要到提交时才发生 ——
    而提交时 `before_commit` 在最后一次 flush **之前**。拦截层不先 flush 的话，这条新建漏记
    （PostgreSQL / SQL Server 都实测过）"""
    (record,) = changes_of('role', temp_role)
    assert record['action'] == 'create'
    assert field(record, 'code') == {'field': 'code', 'label': '角色编码', 'new': 'PYTEST_DC'}


def test_role_menus_record_the_net_change_with_titles(
    client: TestClient, token_headers: dict[str, str], temp_role: str
) -> None:
    menus = [m for m in client.get('/sys/menus', headers=token_headers).json()['data'] if m.get('id')][:3]
    picked = [m['id'] for m in menus[:2]]
    assert (
        client.put(f'/sys/roles/{temp_role}/menus', headers=token_headers, json={'menus': picked}).json()['code'] == 200
    )
    record = [r for r in changes_of('role', temp_role) if r['action'] == 'update'][-1]
    change = field(record, 'menus')
    assert change is not None and sorted(ids(change['added'])) == sorted(str(p) for p in picked)
    assert {m['label'] for m in change['added']} == {m['title'] for m in menus[:2]}

    # 权限矩阵原样再存一次：全删再全插，净变化为零 → 不出记录
    before = len(changes_of('role', temp_role))
    assert (
        client.put(f'/sys/roles/{temp_role}/menus', headers=token_headers, json={'menus': picked}).json()['code'] == 200
    )
    assert len(changes_of('role', temp_role)) == before

    # 换掉一个：只记那一进一出
    swapped = [picked[0], menus[2]['id']]
    assert (
        client.put(f'/sys/roles/{temp_role}/menus', headers=token_headers, json={'menus': swapped}).json()['code']
        == 200
    )
    change = field([r for r in changes_of('role', temp_role) if r['action'] == 'update'][-1], 'menus')
    assert change is not None
    assert ids(change['added']) == [str(menus[2]['id'])] and ids(change['removed']) == [str(picked[1])]


def test_adding_users_to_a_role_lands_on_each_user(
    client: TestClient, token_headers: dict[str, str], temp_role: str, temp_user: str
) -> None:
    res = client.post(f'/sys/roles/{temp_role}/users', headers=token_headers, json={'users': [temp_user]})
    assert res.json()['code'] == 200, res.text
    record = [r for r in changes_of('user', temp_user) if r['action'] == 'update'][-1]
    change = field(record, 'roles')
    assert change is not None and ids(change['added']) == [str(temp_role)]
    assert change['added'][0]['label'] == '审计测试角色'


def test_bulk_config_save_goes_through_executemany_and_is_recorded(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """参数配置批量保存走 `bulk_update_models`（按主键的 executemany UPDATE）"""
    configs = client.get('/sys/configs/all', headers=token_headers, params={'type': 'LOG'}).json()['data']
    target = next(c for c in configs if c['key'] == 'DATA_CHANGE_RETENTION_DAYS')
    body = [{k: target[k] for k in ('id', 'name', 'type', 'key', 'value', 'is_frontend', 'remark')}]
    body[0]['value'] = '200'
    try:
        assert client.put('/sys/configs', headers=token_headers, json=body).json()['code'] == 200
        (record,) = changes_of('config', target['id'])
        assert field(record, 'value') == {'field': 'value', 'label': '键值', 'old': '180', 'new': '200'}
        assert record['entity_label'] == 'DATA_CHANGE_RETENTION_DAYS'
    finally:
        body[0]['value'] = target['value']
        client.put('/sys/configs', headers=token_headers, json=body)


def test_dept_parent_change_snapshots_both_names(client: TestClient, token_headers: dict[str, str]) -> None:
    depts = client.get('/sys/depts', headers=token_headers).json()['data']
    root = depts[0]
    res = client.post(
        '/sys/depts', headers=token_headers, json={'name': '审计测试部门', 'code': 'PYTEST_DC', 'status': 1}
    )
    assert res.json()['code'] == 200, res.text
    with engine().connect() as conn:
        pk = conn.execute(sa.text("SELECT id FROM sys_dept WHERE code = 'PYTEST_DC' AND deleted = 0")).scalar_one()
    try:
        res = client.put(
            f'/sys/depts/{pk}',
            headers=token_headers,
            json={'name': '审计测试部门', 'parent_id': root['id'], 'status': 1, 'sort': 0},
        )
        assert res.json()['code'] == 200, res.text
        record = [r for r in changes_of('dept', pk) if r['action'] == 'update'][-1]
        change = field(record, 'parent_id')
        assert change is not None and change['old'] is None
        assert str(change['new']) == str(root['id']) and change['new_label'] == root['name']
    finally:
        with engine().begin() as conn:
            conn.execute(sa.text('DELETE FROM sys_dept WHERE id = :pk'), {'pk': pk})


# ── 会话层的分支：直接用同步会话造 ─────────────────────────────────────────────


@pytest.fixture
def role_row() -> Iterator[int]:
    """一行只给这一条测试用的角色（Core INSERT —— 语句式 INSERT 拦截层不记，正好不干扰断言）"""
    pk = 910000000000002601
    with engine().begin() as conn:
        conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': pk})
        conn.execute(
            Role.__table__.insert().values(
                id=pk,
                code='PYTEST_DC_ROW',
                name='会话测试角色',
                status=1,
                is_filter_scopes=True,
                deleted=0,
                created_time=timezone.now(),
            )
        )
    yield pk
    with engine().begin() as conn:
        conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': pk})


def test_rollback_writes_nothing_and_drops_the_buffer(role_row: int) -> None:
    with Session(engine()) as s:
        s.execute(sa.update(Role).where(Role.id == role_row).values(name='回滚掉的名字'))
        s.rollback()
        assert capture._BUFFER not in s.info
        s.execute(sa.update(Role).where(Role.id == role_row).values(remark='提交的备注'))
        s.commit()
    (record,) = changes_of('role', role_row)
    # 回滚掉的那次改名不在里面；没有登录用户 → 来源是「系统」、操作人空
    assert [c['field'] for c in record['changes']] == ['remark']
    assert record['source'] == 'system' and record['actor_id'] is None


def test_two_updates_in_one_transaction_fold_into_one_record(role_row: int) -> None:
    with Session(engine()) as s:
        s.execute(sa.update(Role).where(Role.id == role_row).values(name='第一次'))
        s.execute(sa.update(Role).where(Role.id == role_row).values(name='第二次', remark='顺手'))
        s.commit()
    (record,) = changes_of('role', role_row)
    # 原样是第一次碰到时拍的，比的是提交时的现状：中间值「第一次」不出现
    assert field(record, 'name') == {'field': 'name', 'label': '角色名称', 'old': '会话测试角色', 'new': '第二次'}
    assert field(record, 'remark') is not None


def test_savepoint_rollback_leaves_no_trace(role_row: int) -> None:
    with Session(engine()) as s:
        nested = s.begin_nested()
        s.execute(sa.update(Role).where(Role.id == role_row).values(name='保存点里改的'))
        nested.rollback()
        s.execute(sa.update(Role).where(Role.id == role_row).values(remark='外层改的'))
        s.commit()
    (record,) = changes_of('role', role_row)
    assert [c['field'] for c in record['changes']] == ['remark']


def test_unflushed_add_is_recorded_with_the_source_of_the_moment_it_was_added() -> None:
    """`add()` 在 `with data_change_source(...)` 里面、flush 和提交在外面：来源照样是 add 那一刻的"""
    with Session(engine()) as s:
        with capture.data_change_source('ai', 'create_role'):
            role = Role(code='PYTEST_DC_ADD', name='没 flush 的角色', status=1, is_filter_scopes=True, remark=None)
            s.add(role)
        s.commit()
        pk = role.id
    try:
        (record,) = changes_of('role', pk)
        assert record['action'] == 'create' and record['source'] == 'ai' and record['source_ref'] == 'create_role'
    finally:
        with engine().begin() as conn:
            conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': pk})


def test_created_and_deleted_in_one_transaction_is_not_recorded() -> None:
    with Session(engine()) as s:
        role = Role(code='PYTEST_DC_GONE', name='建了又删', status=1, is_filter_scopes=True, remark=None)
        s.add(role)
        s.flush()
        pk = role.id
        s.execute(sa.delete(Role).where(Role.id == pk))
        s.commit()
    assert changes_of('role', pk) == []


def test_explicit_actor_wins_over_the_request_context(role_row: int) -> None:
    with Session(engine()) as s, capture.data_change_source('ai', 'mcp:x update_role', actor_id=role_row):
        s.execute(sa.update(Role).where(Role.id == role_row).values(remark='AI 改的'))
        s.commit()
    (record,) = changes_of('role', role_row)
    assert record['source'] == 'ai' and record['actor_id'] == role_row and record['source_ref'] == 'mcp:x update_role'


def test_a_statement_hitting_too_many_rows_becomes_one_bulk_summary(
    role_row: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    second = role_row + 1
    with engine().begin() as conn:
        conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': second})
        conn.execute(
            Role.__table__.insert().values(
                id=second,
                code='PYTEST_DC_ROW2',
                name='会话测试角色2',
                status=1,
                is_filter_scopes=True,
                deleted=0,
                created_time=timezone.now(),
            )
        )
    monkeypatch.setattr(capture, 'BULK_LIMIT', 1)
    try:
        with Session(engine()) as s:
            s.execute(sa.update(Role).where(Role.id.in_([role_row, second])).values(status=0))
            s.commit()
        with engine().connect() as conn:
            rows = (
                conn
                .execute(
                    sa.select(DataChange.__table__).where(DataChange.entity_type == 'role', DataChange.action == 'bulk')
                )
                .mappings()
                .all()
            )
        (bulk,) = rows
        assert bulk['entity_id'] is None and bulk['entity_label'] == '2'
        assert bulk['changes'] == [{'field': 'status', 'label': '状态', 'new': 0, 'new_label': '停用'}]
        assert changes_of('role', role_row) == []  # 没有逐行记
    finally:
        with engine().begin() as conn:
            conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': second})


# ── 登记表的守卫 ──────────────────────────────────────────────────────────────


def _table(*columns: str) -> sa.Table:
    return sa.Table(
        'pytest_dc_probe',
        sa.MetaData(),
        sa.Column('id', sa.BigInteger, primary_key=True),
        *(sa.Column(c, sa.String(10)) for c in columns),
    )


def test_an_unclassified_column_is_refused_at_registration() -> None:
    with pytest.raises(ValueError, match=r'没归类.*api_token'):
        registry.register_audited(
            _table('name', 'api_token'), entity='pytest_probe', title='探针', label='name', fields={'name': '名称'}
        )
    assert 'pytest_probe' not in registry.ENTITIES


@pytest.mark.parametrize(
    ('kwargs', 'message'),
    [
        ({'fields': {'name': '名称', 'nope': '不存在'}}, '没有这些列'),
        ({'fields': {'name': '名称'}, 'ignore': {'name'}}, '同时出现在'),
        ({'fields': {'name': '名称'}, 'enums': {'missing': {0: 'x'}}}, 'enums 只能给'),
    ],
)
def test_registration_refuses_unknown_and_double_classified_columns(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        registry.register_audited(_table('name'), entity='pytest_probe', title='探针', label='name', **kwargs)


def _repo_root() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve()
    return next(p for p in here.parents if (p / 'pnpm-workspace.yaml').exists())


def test_every_label_is_translated_and_whitelisted() -> None:
    """字段名 / 对象名 / 取值名 / 来源 / 动作都是服务端下发、前端 `t(label)` 翻的：不在语言包里，英文界面就是中文；
    不在 `server-data-keys.json` 里，`pnpm i18n:fix` 会把它们当孤儿删掉"""
    registry.load_data_change_extensions()
    labels: set[str] = set(registry.SOURCES.values()) | set(registry.ACTIONS.values())
    for spec in registry.ENTITIES.values():
        labels |= {spec.title, *spec.labels.values()}
        for values in spec.enums.values():
            labels |= set(values.values())
    labels |= {s.label for s in registry.SETS.values()}

    root = _repo_root() / 'packages/i18n/src'
    en = json.loads((root / 'locales/en-US.json').read_text(encoding='utf-8'))
    zh = json.loads((root / 'locales/zh-CN.json').read_text(encoding='utf-8'))
    whitelist = set(json.loads((root / 'server-data-keys.json').read_text(encoding='utf-8')))
    assert not sorted(labels - set(en)), '这些标签 en-US.json 里没有'
    assert not sorted(labels - set(zh)), '这些标签 zh-CN.json 里没有'
    assert not sorted(labels - whitelist), '这些标签 server-data-keys.json 里没有'


_AUDITED_MODELS = ('User', 'Dept', 'Role', 'Menu', 'Config')


def test_production_code_has_no_write_the_capture_cannot_see() -> None:
    """🔴 拦截层看不见的写法：原生 SQL · 语句式 INSERT（拿不到主键）· 绕过 `Session.execute` 的连接级写入。

    运行时不报错（测试收尾大量用它们硬删数据），所以在这里把**生产代码**挡住 —— 漏网的写入是静默的
    """
    registry.load_data_change_extensions()
    backend = _repo_root() / 'apps/api/backend'
    tables = '|'.join(sorted(registry.AUDITED_TABLES))
    text_dml = re.compile(rf"text\(\s*[rf]?['\"]\s*(?:UPDATE|DELETE|INSERT)\b[^'\"]*\b(?:{tables})\b", re.IGNORECASE)
    stmt_insert = re.compile(rf'\binsert\(\s*(?:{"|".join(_AUDITED_MODELS)})\b')
    offenders = []
    for path in backend.rglob('*.py'):
        rel = path.relative_to(backend).as_posix()
        # 拦截层自己的 docstring 里就写着这些写法（讲它为什么拦不到）
        if (
            '/tests/' in rel
            or rel.startswith(('alembic/', 'scripts/', 'common/data_change/'))
            or rel in ('cli.py', 'conftest.py')
        ):
            continue
        body = path.read_text(encoding='utf-8')
        offenders += [f'{rel}: text() 写登记表' for _ in text_dml.finditer(body)]
        offenders += [f'{rel}: 语句式 insert({m.group(0)})' for m in stmt_insert.finditer(body)]
    for rel in (
        'app/admin/crud/crud_user.py',
        'app/admin/crud/crud_dept.py',
        'app/admin/crud/crud_role.py',
        'app/admin/crud/crud_menu.py',
        'plugin/config/crud/crud_config.py',
    ):
        body = (backend / rel).read_text(encoding='utf-8')
        for bad in ('pk_mode=False', '.connection()', 'bulk_create_models', 'text('):
            if bad in body:
                offenders.append(f'{rel}: {bad}')
    assert not offenders, '\n'.join(offenders)


# ── 接口 ──────────────────────────────────────────────────────────────────────


def test_list_filters_by_object_field_and_trace(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    detail = client.get(f'/sys/users/{temp_user}', headers=token_headers).json()['data']
    client.put(f'/sys/users/{temp_user}', headers=token_headers, json=_user_body(detail, nickname='筛选用'))

    def page(**params: Any) -> list[dict[str, Any]]:
        res = client.get('/logs/changes', headers=token_headers, params={'size': 50, **params})
        assert res.json()['code'] == 200, res.text
        return res.json()['data']['items']

    mine = page(entity_type='user', entity_id=temp_user)
    assert [r['action'] for r in mine] == ['update', 'create']  # 新的在前
    # ID 下发成字符串（硬纪律 6）
    assert mine[0]['entity_id'] == str(temp_user) and isinstance(mine[0]['id'], str)
    by_field = page(entity_type='user', entity_id=temp_user, field='nickname')
    assert len(by_field) == 2
    # `,name,` 不能命中 `,nickname,`
    assert page(entity_type='user', entity_id=temp_user, field='name') == []
    assert [r['id'] for r in page(trace_id=mine[0]['trace_id'])] == [mine[0]['id']]


def test_meta_lists_entities_fields_sources(client: TestClient, token_headers: dict[str, str]) -> None:
    res = client.get('/logs/changes/meta', headers=token_headers)
    assert res.json()['code'] == 200, res.text
    data = res.json()['data']
    user = next(e for e in data['entities'] if e['entity'] == 'user')
    assert {'field': 'roles', 'label': '角色'} in user['fields']
    assert {'field': 'password', 'label': '密码'} in user['fields']
    assert {'value': 'ai', 'label': 'AI 助手'} in data['sources']
    assert {e['entity'] for e in data['entities']} >= {'user', 'dept', 'role', 'menu', 'config'}


def test_opera_log_filters_by_trace_id(client: TestClient, token_headers: dict[str, str]) -> None:
    """「数据变更」详情里的「看这次请求的操作日志」带着 trace_id 跳过去：操作日志要能按它精确筛"""
    from backend.app.admin.model import OperaLog

    trace = 'pytestdatachangetrace0000000001'
    other = 'pytestdatachangetrace0000000002'
    with engine().begin() as conn:
        conn.execute(sa.delete(OperaLog.__table__).where(OperaLog.trace_id.in_([trace, other])))
        for pk, tid in ((910000000000002701, trace), (910000000000002702, other)):
            conn.execute(
                OperaLog.__table__.insert().values(
                    id=pk,
                    trace_id=tid,
                    username='pytest',
                    method='PUT',
                    title='t',
                    path='/t',
                    ip='127.0.0.1',
                    os='t',
                    browser='t',
                    device='t',
                    code='200',
                    status=1,
                    cost_time=1.0,
                    opera_time=timezone.now(),
                    created_time=timezone.now(),
                )
            )
    try:
        res = client.get('/logs/opera', headers=token_headers, params={'trace_id': trace})
        assert res.json()['code'] == 200, res.text
        assert [r['trace_id'] for r in res.json()['data']['items']] == [trace]
        # 导出用的筛选模型是 extra='forbid'：页面带着 trace_id 去导出，模型里没有就是 422。
        # 操作日志单独派生了一个带 trace_id 的；登录日志那份照旧不认它
        from pydantic import ValidationError

        from backend.app.admin.dataio import LogExportFilters, OperaLogExportFilters

        assert OperaLogExportFilters.model_validate({'trace_id': trace}).trace_id == trace
        with pytest.raises(ValidationError):
            LogExportFilters.model_validate({'trace_id': trace})
    finally:
        with engine().begin() as conn:
            conn.execute(sa.delete(OperaLog.__table__).where(OperaLog.trace_id.in_([trace, other])))
