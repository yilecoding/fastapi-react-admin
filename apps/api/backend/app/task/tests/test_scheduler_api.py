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


def test_meta_lists_only_our_tasks(client: TestClient, token_headers):
    """下拉里只该出现我们自己的任务，不该出现 celery.backend_cleanup 那些。"""
    r = client.get(f'{BASE}/meta', headers=token_headers)
    assert r.status_code == 200, r.text
    names = r.json()['data']['tasks']
    assert 'maintenance.prune_logs' in names
    assert not any(n.startswith('celery.') for n in names)


def test_meta_exposes_beat_timezone(client: TestClient, token_headers):
    """🔴 beat 的时区必须下发给前端。

    前端算「近五次执行时间」预览要按 **beat 解释 crontab 的那个时区**算。
    用浏览器时区去算，在运维和服务器不同区时会得到一个看着像模像样、
    实际和真正触发时刻差好几小时的预览 —— 而这个预览存在的全部意义
    就是让人确认「是不是按我想的时间跑」。

    ⚠️ 它和 `sys_user.timezone` 是两回事：后者是每个人的**显示**偏好，
    不参与任何服务端计算（见 `model/user.py` 那一列的注释）。
    """
    from zoneinfo import ZoneInfo

    from backend.core.conf import settings

    tz = client.get(f'{BASE}/meta', headers=token_headers).json()['data']['timezone']
    assert tz == settings.DATETIME_TIMEZONE
    # 必须是浏览器 Intl 认得的 IANA 名字，不能是 '+08:00' 这种偏移量
    ZoneInfo(tz)


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


@pytest.mark.parametrize(
    ('expr', 'why'),
    [
        ('0 0 0 * * ? *', 'Quartz 七段（秒 分 时 日 月 周 年）'),
        ('* * * * * ?', 'Quartz 六段'),
        ('0 0 * * ?', 'Quartz 的 ?（该字段不指定）'),
        ('0 0 L * *', 'Quartz 的 L（每月最后一天）'),
        ('0 0 * * 1#2', 'Quartz 的 #（第 N 个星期几）'),
        ('0 0 15W * *', 'Quartz 的 W（最近的工作日）'),
    ],
)
def test_quartz_syntax_is_rejected(client: TestClient, token_headers, uniq, expr, why):
    """🔴 Quartz 语法必须被拦在门外。

    网上绝大多数「Cron 表达式生成器」产出的是 **Quartz**（7 段、`?`、`L`、`W`、`#`），
    而 celery 用的是 **Unix 5 段**。实测 celery 的反应：

        0 0 0 * * ? *  → 只接受 5 段，收到 7 段
        0 0 * * ?      → Invalid weekday literal '?'
        0 0 L * *      → Invalid weekday literal 'L'

    如果放进来，后果是**静默的**：`all_as_schedule` 只能跳过这一条（否则整个
    beat 起不来），于是界面上它启用着、实际永远不触发，没有任何地方说明为什么。

    这条同时是一道产品约束的护栏：**「每月最后一天」这类预设不能提供**，
    Unix cron 表达不了它，给个 `0 0 28-31 * *` 的近似值等于偷换承诺。
    """
    r = client.post(
        BASE, headers=token_headers,
        json={'name': uniq, 'task': 'maintenance.prune_logs', 'type': 1, 'crontab': expr},
    )
    assert r.status_code == 422, f'{why} 没被拦住：{r.text[:200]}'


# ── 执行记录的时间范围筛选 ──────────────────────────────────────────────────


@pytest.fixture
def seeded_results():
    """造四条 date_done 已知的执行记录，用完删掉。

    ⚠️ 一律 `microsecond=0`。`date_done` 是 `datetimeoffset`，带微秒，
    而查询参数按 `%H:%M:%S` 格式化会把微秒截掉 —— 边界那条用例
    「起止都卡在记录自己的时刻上」就会因为 `.789 > .000` 而落空。
    第一版没置零，红的是测试不是代码。
    """
    import uuid as _uuid

    from datetime import timedelta

    from sqlalchemy import create_engine, delete, insert
    from sqlalchemy.orm import sessionmaker

    from backend.app.task.celery import get_result_backend
    from backend.app.task.model import TaskExtended
    from backend.core.conf import settings
    from backend.utils.timezone import timezone

    url = get_result_backend().removeprefix('db+').replace(
        f'/{settings.DATABASE_SCHEMA}?', f'/{settings.DATABASE_SCHEMA}_test?'
    )
    factory = sessionmaker(create_engine(url, future=True), expire_on_commit=False)

    tag = f'pytest-range-{_uuid.uuid4().hex[:8]}'
    now = timezone.now().replace(microsecond=0)
    # 'h1' 落在**今天**，专门给「只给日期会丢掉最后一天」那条用例
    marks = {'h1': now - timedelta(hours=1), 'd1': now - timedelta(days=1),
             'd5': now - timedelta(days=5), 'd10': now - timedelta(days=10)}
    with factory() as db:
        for key, at in marks.items():
            db.execute(insert(TaskExtended.__table__).values(
                task_id=f'{tag}-{key}', status='SUCCESS', name=tag, date_done=at,
            ))
        db.commit()

    yield {'tag': tag, 'now': now, 'marks': marks}

    with factory() as db:
        db.execute(delete(TaskExtended.__table__).where(TaskExtended.name == tag))
        db.commit()


FMT = '%Y-%m-%d %H:%M:%S'


def _query(client: TestClient, token_headers, tag: str, **params) -> list[dict]:
    r = client.get(
        '/tasks/results', headers=token_headers,
        params={'name': tag, 'page': 1, 'size': 20, **params},
    )
    assert r.status_code == 200, r.text
    return r.json()['data']['items']


def _keys(items: list[dict]) -> set[str]:
    return {i['task_id'].rsplit('-', 1)[-1] for i in items}


def test_result_time_range_filters(client: TestClient, token_headers, seeded_results):
    """时间范围要真的起作用 —— 四条记录按范围切出来。"""
    from datetime import timedelta

    tag, now = seeded_results['tag'], seeded_results['now']
    assert _keys(_query(client, token_headers, tag)) == {'h1', 'd1', 'd5', 'd10'}

    got = _query(client, token_headers, tag, start_time=(now - timedelta(days=7)).strftime(FMT))
    assert _keys(got) == {'h1', 'd1', 'd5'}, got

    got = _query(client, token_headers, tag, end_time=(now - timedelta(days=7)).strftime(FMT))
    assert _keys(got) == {'d10'}, got

    got = _query(
        client, token_headers, tag,
        start_time=(now - timedelta(days=7)).strftime(FMT),
        end_time=(now - timedelta(days=3)).strftime(FMT),
    )
    assert _keys(got) == {'d5'}, got


def test_range_is_inclusive_on_both_ends(client: TestClient, token_headers, seeded_results):
    """🔴 两端都是闭区间。

    写成开区间（`>` / `<`）的话，「查 8/22 00:00:00 ~ 8/22 23:59:59」会漏掉
    正好落在这两个时刻上的记录 —— 一天里最早和最晚那几条查不到，
    而列表看起来完全正常，只是少了两行。
    """
    tag = seeded_results['tag']
    exact = seeded_results['marks']['d5'].strftime(FMT)
    got = _query(client, token_headers, tag, start_time=exact, end_time=exact)
    assert _keys(got) == {'d5'}, f'闭区间没命中边界上的那条：{got}'


def test_end_time_without_clock_silently_drops_the_last_day(
    client: TestClient, token_headers, seeded_results
):
    """🔴 这条把「只传日期」的后果钉住，防的是前端偷懒。

    `end_time=2026-08-22`（不带时分秒）会被 pydantic 解析成当天 **00:00:00**，
    于是 `date_done <= 00:00:00` **静默丢掉 22 号一整天**。用户选了「到今天」，
    今天的记录一条都不显示，而界面上没有任何异常。

    前端必须补成 `… 23:59:59` 再发（`query-bar` 的 `toQueryParams` 负责，
    URL 上才压缩成 `time=a~b`）。这条断言的是**后端的行为确实如此**——
    是在提醒「别把补时分秒那一步省掉」，不是在要求后端去猜。

    ⚠️ 用 `h1`（一小时前，落在今天）来演示。第一版拿 `d1`（一天前 = 昨天）
    演示，而昨天本来就在「今天 00:00」之前，什么也证明不了 —— 又是测试写错。
    """
    tag, now = seeded_results['tag'], seeded_results['now']
    today = now.strftime('%Y-%m-%d')

    with_clock = _keys(_query(client, token_headers, tag, end_time=f'{today} 23:59:59'))
    date_only = _keys(_query(client, token_headers, tag, end_time=today))

    assert 'h1' in with_clock, f'补了时分秒也没查到今天的记录：{with_clock}'
    # 刚过午夜时 h1 会落到昨天，那时这条演示不成立，跳过
    if now.hour >= 1:
        assert 'h1' not in date_only, (
            f'只给日期居然命中了今天的记录 —— pydantic 的解析口径变了？{date_only}'
        )
        assert with_clock > date_only, '只给日期没有丢掉任何东西，这条用例失去意义'


def test_every_schedule_in_db_points_at_a_registered_task(client: TestClient, token_headers):
    """🔴 库里每一条启用的调度，任务名都必须真的注册过。

    创建时 service 层校验过，但那只挡住「打错字」—— 任务名住在**代码**里，
    改个名或删掉一个任务，库里已有的调度就指向了空，而**没有任何一次写操作
    会经过校验**。这条测试是唯一能在 CI 里发现它的地方。

    它同时守住两件事：
    - **种子 SQL 里的任务名拼错**（种子是手写的，没有任何东西校验它）
    - **重命名任务后忘了改调度**

    失败的样子有多不可见：beat 照常派发 →「累计触发」照涨 → worker 收到
    一个不认识的名字只记一条 `Received unregistered task`，**不产生执行记录**。
    界面上这条看着在正常运行，执行记录里一条都没有。
    """
    registered = set(client.get(f'{BASE}/meta', headers=token_headers).json()['data']['tasks'])
    rows = client.get(f'{BASE}/all', headers=token_headers).json()['data']

    broken = [
        f"「{r['name']}」→ {r['task']}"
        for r in rows
        if r['enabled'] and r['task'] not in registered
    ]
    assert not broken, (
        '这些调度指向未注册的任务，会按时触发但什么都不执行：\n  '
        + '\n  '.join(broken)
        + f'\n可用的任务：{sorted(registered)}'
    )


def test_fresh_install_has_every_index_the_models_declare(client: TestClient, token_headers):
    """🔴 模型声明的索引，在库里必须真的存在。

    这几轮加索引的路子是「改模型 + 手工 CREATE INDEX」（没有 alembic）——
    两步之间**没有任何东西对账**。少做一步的后果：
    - 只改模型 → 现有环境上没有索引，清理任务全表扫、锁表
    - 只手工建 → 全新安装（`create_all`）没有这个索引，同上

    而两种都**不报错**：功能全对，只是慢，而且要到日志表长起来才显形。

    这条测试是唯一的对账：拿模型里声明的索引名去库里查。
    ⚠️ 它查的是 **fba_test**（conftest 指过去的那个库），所以
    「改完模型忘了在测试库建索引」也会被它抓到。
    """
    from sqlalchemy import create_engine, text

    from backend.app.task.celery import get_result_backend
    from backend.common.model import MappedBase
    from backend.core.conf import settings

    watched = ['task_result', 'task_scheduler', 'sys_login_log', 'sys_opera_log']
    want: set[tuple[str, str]] = set()
    for name in watched:
        table = MappedBase.metadata.tables[name]
        for idx in table.indexes:
            want.add((name, idx.name))

    url = get_result_backend().removeprefix('db+').replace(
        f'/{settings.DATABASE_SCHEMA}?', f'/{settings.DATABASE_SCHEMA}_test?'
    )
    engine = create_engine(url, future=True)
    try:
        with engine.connect() as conn:
            have = {
                (r[0], r[1])
                for r in conn.execute(text(
                    'SELECT t.name, i.name FROM sys.indexes i '
                    'JOIN sys.tables t ON t.object_id = i.object_id '
                    'WHERE i.name IS NOT NULL'
                ))
            }
    finally:
        engine.dispose()

    missing = sorted(f'{t}.{i}' for t, i in want - have)
    assert not missing, (
        '模型里声明了这些索引，库里却没有 —— 改了模型但没在库上建（没有 alembic，'
        f'这两步靠人对账）：\n  ' + '\n  '.join(missing)
    )
