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

from backend.app.admin.model import DataChange, Role, User, UserMfa
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
        labels |= {label for _, label in registry.folded_fields(spec.entity)}
    for child in registry.CHILDREN.values():
        labels |= set(child.states)

    root = _repo_root() / 'packages/i18n/src'
    en = json.loads((root / 'locales/en-US.json').read_text(encoding='utf-8'))
    zh = json.loads((root / 'locales/zh-CN.json').read_text(encoding='utf-8'))
    whitelist = set(json.loads((root / 'server-data-keys.json').read_text(encoding='utf-8')))
    assert not sorted(labels - set(en)), '这些标签 en-US.json 里没有'
    assert not sorted(labels - set(zh)), '这些标签 zh-CN.json 里没有'
    assert not sorted(labels - whitelist), '这些标签 server-data-keys.json 里没有'


def _audited_models() -> list[str]:
    """登记成对象的映射类名（语句式 `insert(User)` 拿不到主键）。

    关联表 / 子表的语句式 INSERT 拦得到（父 ID 在参数里），不在这份里
    """
    from backend.common.model import MappedBase

    tables = {spec.table.name for spec in registry.ENTITIES.values()}
    return sorted(m.class_.__name__ for m in MappedBase.registry.mappers if m.local_table.name in tables)


def test_production_code_has_no_write_the_capture_cannot_see() -> None:
    """🔴 拦截层看不见的写法：原生 SQL · 语句式 INSERT（拿不到主键）· 绕过 `Session.execute` 的连接级写入。

    运行时不报错（测试收尾大量用它们硬删数据），所以在这里把**生产代码**挡住 —— 漏网的写入是静默的
    """
    registry.load_data_change_extensions()
    backend = _repo_root() / 'apps/api/backend'
    tables = '|'.join(sorted(registry.AUDITED_TABLES))
    text_dml = re.compile(rf"text\(\s*[rf]?['\"]\s*(?:UPDATE|DELETE|INSERT)\b[^'\"]*\b(?:{tables})\b", re.IGNORECASE)
    models = _audited_models()
    assert {'User', 'Config'} <= set(models)
    stmt_insert = re.compile(rf'\binsert\(\s*(?:{"|".join(models)})\b')
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
        'plugin/oauth2/crud/crud_user_social.py',
        'app/admin/service/mfa_service.py',
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


# ── 评审补的（#262）────────────────────────────────────────────────────────────


def test_a_password_like_config_value_is_recorded_as_secret(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 `EMAIL_PASSWORD`（SMTP 密码 / 授权码）就存在参数配置里：键名像密码的那几行，值只记「改过」"""
    configs = client.get('/sys/configs/all', headers=token_headers, params={'type': 'EMAIL'}).json()['data']
    target = next(c for c in configs if c['key'] == 'EMAIL_PASSWORD')
    body = [{k: target[k] for k in ('id', 'name', 'type', 'key', 'value', 'is_frontend', 'remark')}]
    body[0]['value'] = 'smtp-app-code-pytest'
    try:
        assert client.put('/sys/configs', headers=token_headers, json=body).json()['code'] == 200
        (record,) = changes_of('config', target['id'])
        assert field(record, 'value') == {'field': 'value', 'label': '键值', 'secret': True}
        assert 'smtp-app-code-pytest' not in json.dumps(record['changes'])
    finally:
        body[0]['value'] = target['value']
        client.put('/sys/configs', headers=token_headers, json=body)


def test_a_savepoint_commit_does_not_split_or_drop_the_record(role_row: int) -> None:
    """🔴 保存点提交也会触发 before_commit / after_commit（AI 工具每调用一次就开一个保存点写调用审计）。
    不跳过的话一个事务拆成两条，或者保存点之前抓到的改动被 after_commit 清掉"""
    with Session(engine()) as s:
        s.execute(sa.update(Role).where(Role.id == role_row).values(name='保存点之前'))
        with s.begin_nested():
            s.execute(sa.update(Role).where(Role.id == role_row).values(remark='保存点里'))
        s.execute(sa.update(Role).where(Role.id == role_row).values(status=0))
        s.commit()
    (record,) = changes_of('role', role_row)
    assert sorted(c['field'] for c in record['changes']) == ['name', 'remark', 'status']


def test_writing_only_ignored_columns_skips_the_capture(temp_user: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """每次登录都 `update_login_time`（只写忽略列）：不该为它前后各查一次整行"""
    calls: list[Any] = []
    real = capture._fetch
    monkeypatch.setattr(capture, '_fetch', lambda session, stmt: calls.append(stmt) or real(session, stmt))
    with Session(engine()) as s:
        s.execute(sa.update(User).where(User.id == int(temp_user)).values(last_login_time=timezone.now()))
        s.commit()
    assert calls == []
    assert [r for r in changes_of('user', temp_user) if r['action'] == 'update'] == []


@pytest.fixture
def two_roles(role_row: int) -> Iterator[tuple[int, int]]:
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
    yield role_row, second
    with engine().begin() as conn:
        conn.execute(sa.text('DELETE FROM sys_user_role WHERE role_id IN (:a, :b)'), {'a': role_row, 'b': second})
        conn.execute(sa.text('DELETE FROM sys_role WHERE id = :pk'), {'pk': second})


def test_executemany_over_the_limit_is_one_summary_without_a_pre_select(
    two_roles: tuple[int, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """按主键的批量 UPDATE 超过上限：不把几千个主键塞进一个 IN（SQL Server 2100 个参数的上限），直接记汇总"""
    monkeypatch.setattr(capture, 'BULK_LIMIT', 1)
    a, b = two_roles
    with Session(engine()) as s:
        s.execute(sa.update(Role), [{'id': a, 'remark': '甲'}, {'id': b, 'remark': '乙'}])
        s.commit()
    with engine().connect() as conn:
        (bulk,) = (
            conn
            .execute(
                sa.select(DataChange.__table__).where(DataChange.entity_type == 'role', DataChange.action == 'bulk')
            )
            .mappings()
            .all()
        )
    assert bulk['entity_label'] == '2'
    assert bulk['changes'] == [{'field': 'remark', 'label': '备注', 'varies': True}]


def test_an_association_delete_over_the_limit_is_one_summary(
    two_roles: tuple[int, int], temp_user: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 关联表也要有上限：从很多人身上摘掉一个角色，不能逐个父对象拍集合、写几万行记录"""
    role, _ = two_roles
    with engine().begin() as conn:
        admin_id = conn.execute(sa.text("SELECT id FROM sys_user WHERE username = 'admin'")).scalar_one()
        for i, uid in enumerate((admin_id, int(temp_user))):
            conn.execute(
                sa.text('INSERT INTO sys_user_role (id, user_id, role_id) VALUES (:id, :u, :r)'),
                {'id': 910000000000002801 + i, 'u': uid, 'r': role},
            )
    monkeypatch.setattr(capture, 'BULK_LIMIT', 1)
    from backend.app.admin.model import user_role

    with Session(engine()) as s:
        s.execute(sa.delete(user_role).where(user_role.c.role_id == role))
        s.commit()
    with engine().connect() as conn:
        (bulk,) = (
            conn
            .execute(
                sa.select(DataChange.__table__).where(DataChange.entity_type == 'user', DataChange.action == 'bulk')
            )
            .mappings()
            .all()
        )
    assert bulk['entity_label'] == '2'
    (change,) = bulk['changes']
    assert change['field'] == 'roles' and change['added'] == []
    assert [m['label'] for m in change['removed']] == ['会话测试角色']


def test_editing_a_partially_loaded_object_records_only_what_changed(role_row: int) -> None:
    """改已加载对象：原样从库里查。用属性历史的话，没加载过的列（`load_only`）会被当成「从空改成了现值」"""
    from sqlalchemy.orm import load_only

    with Session(engine()) as s:
        role = s.get(Role, role_row, options=[load_only(Role.id, Role.name)])
        assert role is not None
        with capture.data_change_source('ai', 'rename_role'):
            role.name = '改了名字'
        # flush 和提交都在 `with` 外面：来源要按改属性的那一刻算
        s.commit()
    (record,) = changes_of('role', role_row)
    assert record['changes'] == [{'field': 'name', 'label': '角色名称', 'old': '会话测试角色', 'new': '改了名字'}]
    assert record['source'] == 'ai' and record['source_ref'] == 'rename_role'


def test_celery_tasks_record_their_changes_as_scheduled_tasks() -> None:
    """worker 里没有请求上下文：不接这一层的话任务改的数据记成「系统」，筛选里的「定时任务」永远是空的"""
    import asyncio

    from backend.app.task.tasks.base import with_timeout

    @with_timeout(5)
    async def probe() -> capture.Origin:
        await asyncio.sleep(0)  # 真的过一次事件循环：wait_for 建的任务要继承上下文变量
        return capture.current_origin()

    # 一次性循环跑一个不碰 Redis / 数据库的协程（`backend/tests` 分册那条「不要 asyncio.run」说的是共享 Redis 的循环）
    loop = asyncio.new_event_loop()
    try:
        origin = loop.run_until_complete(probe())
    finally:
        loop.close()
    assert origin.source == 'task' and origin.source_ref == 'api_v1.probe'


# ── 二期：一对一子表（二次验证）· 逻辑删除的关联表（第三方账号）────────────────
# 接口流程（开启 / 关闭 / 重置 / 重新生成恢复码 / 登录时绑定）在 `test_mfa.py::TestChangeRecords`，
# 绑定 / 解绑在 `plugin/oauth2/tests/test_social_change_records.py`。这里只测拦截层自己的分支。


def mfa_changes(uid: int) -> list[dict[str, Any]]:
    """这个人名下和二次验证有关的记录（临时用户自己还有一条「新建」，别的种子用户可能有别的测试留下的记录）"""
    return [r for r in changes_of('user', uid) if any(c['field'].startswith('mfa') for c in r['changes'])]


@pytest.fixture
def mfa_rows(temp_user: str) -> Iterator[list[int]]:
    """两个人各一行二次验证（直接走连接写库，不经过会话 —— 这里测的是拦截层，不是开启流程）。
    不用 admin：Swagger 调试口拒绝开了二次验证的账号"""
    with engine().begin() as conn:
        other = conn.execute(
            sa
            .select(User.id)
            .where(User.username != 'admin', User.id != int(temp_user), User.deleted == 0)
            .order_by(User.id)
            .limit(1)
        ).scalar_one()
        users = [int(temp_user), other]
        conn.execute(sa.delete(UserMfa.__table__).where(UserMfa.user_id.in_(users)))
        conn.execute(
            sa.insert(UserMfa.__table__),
            [
                {
                    'id': 910000000000002901 + i,
                    'user_id': uid,
                    'secret_cipher': '00',
                    'recovery_hashes': json.dumps([{'h': f'h{i}', 'used': None}]),
                    'last_step': 1,
                    'enabled_time': timezone.now(),
                    'created_time': timezone.now(),
                }
                for i, uid in enumerate(users)
            ],
        )
    yield users
    with engine().begin() as conn:
        conn.execute(sa.delete(UserMfa.__table__).where(UserMfa.user_id.in_(users)))


def test_a_child_table_delete_over_the_limit_is_one_summary(
    mfa_rows: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capture, 'BULK_LIMIT', 1)
    with Session(engine()) as s:
        s.execute(sa.delete(UserMfa).where(UserMfa.user_id.in_(mfa_rows)))
        s.commit()
    with engine().connect() as conn:
        (bulk,) = (
            conn
            .execute(
                sa.select(DataChange.__table__).where(DataChange.entity_type == 'user', DataChange.action == 'bulk')
            )
            .mappings()
            .all()
        )
    assert bulk['entity_label'] == '2'
    # 没有逐个人记
    assert mfa_changes(mfa_rows[0]) == [] and mfa_changes(mfa_rows[1]) == []
    assert bulk['changes'] == [{'field': 'mfa', 'label': '二次验证', 'varies': True}]


def test_writing_only_ignored_child_columns_skips_the_capture(
    mfa_rows: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """每次用动态码登录都写 `last_step`：既不该出记录，也不该白查两次（ORM 改属性、语句 UPDATE 两条路都是）"""
    calls: list[str] = []
    real = capture._snapshot

    def counting(session: Session, spec: Any, parents: list[Any]) -> dict[Any, Any]:
        calls.append(spec.table.name)
        return real(session, spec, parents)

    monkeypatch.setattr(capture, '_snapshot', counting)
    uid = mfa_rows[0]
    with Session(engine()) as s:
        row = s.scalars(sa.select(UserMfa).where(UserMfa.user_id == uid)).one()
        row.last_step = 99
        s.commit()
        s.execute(sa.update(UserMfa).where(UserMfa.user_id == uid).values(last_step=100))
        s.commit()
    assert calls == []
    assert mfa_changes(uid) == []

    # 对照：改到别的列就会抓（不然上面那条「不查」可能只是什么都没装上）
    with Session(engine()) as s:
        row = s.scalars(sa.select(UserMfa).where(UserMfa.user_id == uid)).one()
        row.recovery_hashes = json.dumps([{'h': 'new', 'used': None}])
        s.commit()
    assert calls
    (record,) = mfa_changes(uid)
    assert record['changes'] == [{'field': 'mfa_recovery_codes', 'label': '恢复码', 'secret': True}]
    assert '"new"' not in json.dumps(record['changes'])


def test_using_a_recovery_code_is_not_a_change(mfa_rows: list[int]) -> None:
    """登录时用掉一个恢复码只是标上「用过」：比的是这一批是哪几个，不是整段 JSON"""
    uid = mfa_rows[0]
    with Session(engine()) as s:
        row = s.scalars(sa.select(UserMfa).where(UserMfa.user_id == uid)).one()
        row.recovery_hashes = json.dumps([{'h': 'h0', 'used': '2026-11-09T10:00:00+08:00'}])
        s.commit()
    assert mfa_changes(uid) == []


@pytest.mark.parametrize(
    ('kwargs', 'message'),
    [
        ({'ignore': {'nope'}}, '没有这些列'),
        ({'ignore': {'user_id'}}, '父对象列不能忽略'),
        ({'parent': 'nope'}, '没有父对象列'),
    ],
)
def test_child_registration_refuses_bad_columns(kwargs: dict[str, Any], message: str) -> None:
    base: dict[str, Any] = {
        'entity': 'user',
        'parent': 'user_id',
        'field': 'probe',
        'label': '探针',
        'states': ('无', '有'),
    }
    with pytest.raises(ValueError, match=message):
        registry.register_audited_child(_table('user_id', 'flag'), **{**base, **kwargs})
    assert 'pytest_dc_probe' not in registry.CHILDREN


def test_a_folded_field_cannot_shadow_a_column(monkeypatch: pytest.MonkeyPatch) -> None:
    """子表 / 关联表的字段名和对象的普通列撞了：记录里两条变化同名，前端按字段名筛选时分不开"""
    registry.load_data_change_extensions()
    probe = registry.AuditedChild(
        table=_table('user_id'),
        entity='user',
        parent_column='user_id',
        field='nickname',
        label='探针',
        states=('无', '有'),
        values={},
        ignore=frozenset(),
    )
    monkeypatch.setitem(registry.CHILDREN, 'pytest_dc_probe', probe)
    with pytest.raises(ValueError, match=r'user\.nickname 重名'):
        registry._check_folded()
