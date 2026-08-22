"""任务调度接口的集成测试。

打**真实的** fba_test 库（`conftest.py` 覆盖了 get_db），不 mock 数据库 ——
和 `test_file.py` 同一套哲学：mock 掉数据库只能验证「我以为它会这样」，
而这套代码最容易出问题的地方恰恰在 SQL Server 那一层（NVARCHAR、
筛选唯一索引、OFFSET FETCH 要 ORDER BY）。

用例按「坏起来是静默的」挑，不追求覆盖每个分支。
"""

import uuid

import pytest

from starlette.testclient import TestClient

BASE = '/tasks/schedulers'


@pytest.fixture
def uniq() -> str:
    """每条用例用独立名字 —— 库上 (name, deleted) 有唯一约束，
    用固定名字的话第二次跑必然 409，而失败信息看起来像功能坏了。"""
    return f'pytest-{uuid.uuid4().hex[:8]}'


@pytest.fixture
def created(client: TestClient, token_headers: dict[str, str], uniq: str):
    """建一条调度，用完删掉。"""
    r = client.post(
        BASE,
        headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_logs', 'type': 1, 'crontab': '15 3 * * *'},
    )
    assert r.status_code == 200, r.text
    pk = r.json()['data']['id']
    yield pk
    client.request('DELETE', BASE, headers=token_headers, json={'pks': [pk]})


# ── 注册表 ──────────────────────────────────────────────────────────────────


def test_registered_tasks_excludes_celery_internals(client: TestClient, token_headers):
    """下拉里只该出现我们自己的任务，不该出现 celery.backend_cleanup 那些。"""
    r = client.get(f'{BASE}/registered', headers=token_headers)
    assert r.status_code == 200
    names = r.json()['data']
    assert 'maintenance.prune_logs' in names
    assert not any(n.startswith('celery.') for n in names)


# ── 创建 ────────────────────────────────────────────────────────────────────


def test_create_returns_id(client: TestClient, token_headers, created):
    """🔴 创建必须下发 id，而且必须是**字符串**。

    两条都会静默出错：

    - `create_model` 默认不 flush，而 id 是数据库生成的 —— 不加 flush=True
      就返回，响应序列化直接 500（`('response','data','id') Input should be
      a valid integer`）
    - 雪花 ID 约 2^61，超出 JS 的 MAX_SAFE_INTEGER。编码层
      `stringify_unsafe_ints` 统一转成字符串下发 —— 下发成数字的话前端
      解析会精度丢失，回传做更新/删除会命中**错误的记录**（硬纪律 6）
    """
    assert isinstance(created, str), f'雪花 ID 必须以字符串下发，收到 {type(created).__name__}'
    assert created.isdigit() and int(created) > 0


def test_duplicate_name_conflicts(client: TestClient, token_headers, created, uniq):
    """重名要给业务错误，不能让库上的唯一约束抛 IntegrityError。"""
    r = client.post(
        BASE, headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_logs', 'type': 1, 'crontab': '15 3 * * *'},
    )
    assert r.status_code != 200 or r.json().get('code') != 200


def test_unregistered_task_rejected(client: TestClient, token_headers, uniq):
    """🔴 任务名打错必须在保存时就拒绝。

    少个 s 的 `maintenance.prune_log` 存进去之后：调度按时触发、worker 收到
    一个不认识的名字只记一条 `Received unregistered task`，而界面上这条调度的
    「累计触发次数」照涨 —— 看起来一切正常，实际什么都没跑。
    """
    r = client.post(
        BASE, headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_log', 'type': 1, 'crontab': '* * * * *'},
    )
    assert r.status_code != 200 or r.json().get('code') != 200


@pytest.mark.parametrize(
    ('payload', 'why'),
    [
        ({'type': 1, 'crontab': '* * *'}, 'crontab 段数不对'),
        ({'type': 1, 'crontab': '99 * * * *'}, 'crontab 分钟越界'),
        ({'type': 0}, '间隔调度缺间隔字段'),
        ({'type': 1, 'crontab': '* * * * *', 'kwargs': '[1]'}, 'kwargs 不是 JSON 对象'),
        ({'type': 1, 'crontab': '* * * * *', 'args': '{"a":1}'}, 'args 不是 JSON 数组'),
        ({'type': 1, 'crontab': '* * * * *', 'expire_seconds': 60,
          'expire_time': '2030-01-01T00:00:00+08:00'}, '截止时间与秒数二选一'),
    ],
)
def test_invalid_schedule_rejected(client: TestClient, token_headers, uniq, payload, why):
    """配错的调度会**自己跑**，所以在写入口就要拦。

    存进去的后果不是「保存失败」而是「界面上启用着、实际永远不触发」——
    `all_as_schedule` 只能跳过它（否则整个 beat 起不来），没有任何地方
    告诉用户为什么。
    """
    r = client.post(BASE, headers=token_headers, json={'name': uniq, 'task': 'maintenance.prune_logs', **payload})
    assert r.status_code == 422, f'{why} 没被拦住：{r.text[:200]}'


# ── 读 ──────────────────────────────────────────────────────────────────────


def test_paginated_list_works(client: TestClient, token_headers, created):
    """🔴 分页在 SQL Server 上必须有 ORDER BY，否则 OFFSET FETCH 直接报错。"""
    r = client.get(BASE, headers=token_headers, params={'page': 1, 'size': 10})
    assert r.status_code == 200, r.text
    body = r.json()['data']
    assert 'items' in body and body['total'] >= 1


def test_filter_by_name(client: TestClient, token_headers, created, uniq):
    r = client.get(BASE, headers=token_headers, params={'name': uniq, 'page': 1, 'size': 10})
    assert r.status_code == 200
    assert [i['name'] for i in r.json()['data']['items']] == [uniq]


def test_detail(client: TestClient, token_headers, created):
    r = client.get(f'{BASE}/{created}', headers=token_headers)
    assert r.status_code == 200
    assert r.json()['data']['crontab'] == '15 3 * * *'


def test_detail_404(client: TestClient, token_headers):
    r = client.get(f'{BASE}/99999999999999', headers=token_headers)
    assert r.json().get('code') != 200


# ── 改 ──────────────────────────────────────────────────────────────────────


def test_toggle_status_does_not_need_full_object(client: TestClient, token_headers, created):
    """启停走独立接口。

    复用 PUT /{pk} 的话，为了停用一条调度要把 crontab、参数、起止时间
    全带上回传 —— 前端读漏一个字段就清掉一个（角色↔用户那条坑同理）。
    """
    r = client.put(f'{BASE}/{created}/status', headers=token_headers, params={'enabled': False})
    assert r.status_code == 200, r.text
    assert client.get(f'{BASE}/{created}', headers=token_headers).json()['data']['enabled'] is False


def test_update_keeps_name_check(client: TestClient, token_headers, created, uniq):
    r = client.put(
        f'{BASE}/{created}', headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_logs', 'type': 1, 'crontab': '30 4 * * *'},
    )
    assert r.status_code == 200, r.text
    assert client.get(f'{BASE}/{created}', headers=token_headers).json()['data']['crontab'] == '30 4 * * *'


# ── 删 ──────────────────────────────────────────────────────────────────────


def test_soft_delete_hides_from_list(client: TestClient, token_headers, uniq):
    r = client.post(
        BASE, headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_logs', 'type': 1, 'crontab': '15 3 * * *'},
    )
    pk = r.json()['data']['id']
    client.request('DELETE', BASE, headers=token_headers, json={'pks': [pk]})
    listed = client.get(BASE, headers=token_headers, params={'name': uniq, 'page': 1, 'size': 10}).json()
    assert listed['data']['total'] == 0

    # 🔴 软删之后同名必须能再建：`deleted` 不是布尔而是「0 或这一行自己的 id」，
    # 唯一约束是 (name, deleted) —— 这条设计的全部意义就是让它成立
    again = client.post(
        BASE, headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_logs', 'type': 1, 'crontab': '15 3 * * *'},
    )
    assert again.status_code == 200, again.text
    client.request('DELETE', BASE, headers=token_headers, json={'pks': [again.json()['data']['id']]})


# ── 执行记录 ────────────────────────────────────────────────────────────────


def test_results_paginated(client: TestClient, token_headers):
    """执行记录页的数据源。表由 celery 写，这里只读 —— 空表也要能正常翻页。"""
    r = client.get('/tasks/results', headers=token_headers, params={'page': 1, 'size': 10})
    assert r.status_code == 200, r.text
    assert 'items' in r.json()['data']


def test_result_fields_are_extended(client: TestClient, token_headers):
    """🔴 执行记录必须带上 name / worker / retries / queue 四列。

    `Task` 和 `TaskExtended` 是**同一张表**（`extend_existing=True`），但这四列
    只声明在后者上 —— CRUD 绑 `Task` 的话它们在响应里全是 null。

    症状极骗人：接口 200、条数对、时间和状态都对，只有「任务名」「执行节点」
    显示 `—`，看起来像 celery 没写进去，实际是我们没查出来。
    **是在浏览器里打开页面才发现的** —— 原来那条列表用例只断言了
    `'items' in body`，太弱。这条补上真正的断言。
    """
    import uuid as _uuid

    from sqlalchemy import create_engine, delete, insert
    from sqlalchemy.orm import sessionmaker

    from backend.app.task.celery import get_result_backend
    from backend.app.task.model import TaskExtended
    from backend.core.conf import settings

    # 用同步引擎直插 —— 这张表由 celery 写，没有创建接口；
    # conftest 那套 override_get_db 是异步生成器，同步用例里用不了
    url = get_result_backend().removeprefix('db+').replace(
        f'/{settings.DATABASE_SCHEMA}?', f'/{settings.DATABASE_SCHEMA}_test?'
    )
    factory = sessionmaker(create_engine(url, future=True), expire_on_commit=False)

    task_id = f'pytest-{_uuid.uuid4()}'
    with factory() as db:
        db.execute(
            insert(TaskExtended.__table__).values(
                task_id=task_id, status='SUCCESS', name='pytest.demo_task',
                worker='pytest-worker', retries=2, queue='celery',
            )
        )
        db.commit()

    try:
        r = client.get('/tasks/results', headers=token_headers, params={'task_id': task_id, 'page': 1, 'size': 5})
        assert r.status_code == 200, r.text
        items = r.json()['data']['items']
        assert len(items) == 1, f'按 task_id 没查到刚插的那条：{items}'
        row = items[0]
        assert row['name'] == 'pytest.demo_task', f'name 丢了（CRUD 可能绑成了 Task）：{row}'
        assert row['worker'] == 'pytest-worker', f'worker 丢了：{row}'
        assert row['retries'] == 2, f'retries 丢了：{row}'
        assert row['queue'] == 'celery', f'queue 丢了：{row}'
    finally:
        with factory() as db:
            db.execute(delete(TaskExtended.__table__).where(TaskExtended.task_id == task_id))
            db.commit()
