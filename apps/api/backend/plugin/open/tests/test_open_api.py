"""开放接口的守卫测试：鉴权顺序、每种失败的错误码、调用日志、增量同步。真实 HTTP + 测试库 + 真实 Redis。"""

import re
import time

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from sqlalchemy import delete, literal_column, select, update
from starlette.testclient import TestClient

from backend.app.admin.model import Dept
from backend.core.path_conf import BASE_PATH
from backend.main import app
from backend.plugin.open.gateway.auth import DependsOpenApp
from backend.plugin.open.model import OpenApiLog
from backend.plugin.open.service.app_service import open_routes
from backend.plugin.open.service.sync_service import encode_cursor
from backend.plugin.open.tests.conftest import (
    CODE_PREFIX,
    MGMT,
    OPEN_BASE,
    create_app,
    logs_of,
    run_db,
    signed_get,
)
from backend.utils.timezone import timezone

PLUGIN_DIR = Path(__file__).resolve().parents[1]


class TestEveryOpenRouteIsGuarded:
    def test_every_route_under_api_open_has_depends_open_app(self) -> None:
        """🔴 漏挂的那个接口 = 不用签名、谁都能调（JWT 中间件也放行它：没带 Bearer 是「未认证」不是「认证失败」）"""
        routes = open_routes(app)
        assert len(routes) >= 2, '前置：应该找得到开放接口（FastAPI 0.141 起 app.routes 不再摊平子路由）'
        unguarded = [
            r.path for r in routes if not any(isinstance(d.dependency, DependsOpenApp) for d in r.dependencies or [])
        ]
        assert unguarded == [], f'这些开放接口没挂 DependsOpenApp：{unguarded}'

    def test_unsigned_request_is_rejected_not_served(self, client: TestClient) -> None:
        response = client.get(f'{OPEN_BASE}/users')
        assert response.status_code == 400
        assert response.json()['data'] is None

    def test_every_error_code_has_both_translations(self) -> None:
        """错误码是 f-string 拼出来的键，`test_i18n` 的静态扫描看不见，这里补上"""
        codes: set[str] = set()
        for path in PLUGIN_DIR.rglob('*.py'):
            if 'tests' in path.parts:
                continue
            codes |= set(re.findall(r"OpenApiError\(\s*\d+,\s*'open\.(\w+)'", path.read_text(encoding='utf-8')))
        assert len(codes) >= 10, codes
        for lang in ('zh-CN', 'en-US'):
            table = yaml.safe_load((BASE_PATH / 'locale' / f'{lang}.yml').read_text(encoding='utf-8'))['error']['open']
            assert codes <= set(table), f'{lang} 缺：{codes - set(table)}'


class TestAuthFailures:
    """每种失败都要：对的 HTTP 状态 + 对的错误码 + 落一条调用日志"""

    def _last_log(self, app_id: str) -> OpenApiLog:
        rows = logs_of(app_id)
        assert rows, '每次调用都应该落一条调用日志'
        return rows[-1]

    def test_wrong_secret_returns_server_string_to_sign(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        response = signed_get(client, issued, '/users', params='limit=5&cursor=', secret='fra_sk_wrong')
        assert response.status_code == 401
        sts = response.json()['data']['string_to_sign']
        assert sts.startswith('GET\n/api/open/v1/users\ncursor=&limit=5\n')
        log = self._last_log(issued['id'])
        assert (log.status, log.error_code, log.code) == (0, 'open.sign_mismatch', '401')
        assert sts.replace('\n', '\\n') in log.response_body, '详情页靠响应体里的 StringToSign 排查'
        assert log.request_headers['x-sign'] == response.request.headers['x-sign'], 'x-sign 不打码，留着比对'

    def test_replay_is_rejected_by_nonce(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        ts, nonce = str(int(time.time() * 1000)), 'pytest-replay-nonce'
        first = signed_get(client, issued, '/users', timestamp=ts, nonce=nonce)
        again = signed_get(client, issued, '/users', timestamp=ts, nonce=nonce)
        assert first.status_code == 200
        assert again.status_code == 401
        assert self._last_log(issued['id']).error_code == 'open.nonce_reused'

    def test_bad_signature_does_not_burn_the_nonce(self, client: TestClient, token_headers: dict) -> None:
        """先验签后消费 nonce：签错一次再修好重发，同一个 nonce 不该被当成重放"""
        issued = create_app(client, token_headers)
        ts, nonce = str(int(time.time() * 1000)), 'pytest-retry-nonce'
        wrong = signed_get(client, issued, '/users', timestamp=ts, nonce=nonce, secret='fra_sk_wrong')
        fixed = signed_get(client, issued, '/users', timestamp=ts, nonce=nonce)
        assert wrong.status_code == 401
        assert fixed.status_code == 200, fixed.text

    def test_stale_timestamp(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        stale = str(int(time.time() * 1000) - 10 * 60 * 1000)
        response = signed_get(client, issued, '/users', timestamp=stale)
        assert response.status_code == 401
        assert abs(response.json()['data']['server_time'] - time.time() * 1000) < 60_000, (
            '回带服务端时间，对方一眼看出时钟差'
        )
        assert self._last_log(issued['id']).error_code == 'open.timestamp_expired'

    def test_scope_denied(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers, scopes=['user:read'])
        response = signed_get(client, issued, '/depts')
        assert response.status_code == 403
        log = self._last_log(issued['id'])
        assert (log.error_code, log.scope, log.scope_granted) == ('open.scope_denied', 'dept:read', False)

    def test_ip_not_in_whitelist(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers, ip_whitelist=['10.20.0.0/16'])
        response = signed_get(client, issued, '/users')
        assert response.status_code == 403
        log = self._last_log(issued['id'])
        assert (log.error_code, log.ip_whitelisted) == ('open.ip_denied', False)

    def test_disabled_and_expired(self, client: TestClient, token_headers: dict) -> None:
        disabled = create_app(client, token_headers, suffix='OFF', status=0)
        assert signed_get(client, disabled, '/users').status_code == 401
        assert self._last_log(disabled['id']).error_code == 'open.app_disabled'

        past = (timezone.now() - timedelta(minutes=1)).isoformat()
        expired = create_app(client, token_headers, suffix='OLD', expire_time=past)
        assert signed_get(client, expired, '/users').status_code == 401
        assert self._last_log(expired['id']).error_code == 'open.app_expired'

    def test_unknown_access_key_is_logged_without_app(self, client: TestClient) -> None:
        fake = {'access_key': 'fra_ak_PYTEST_unknown', 'secret_key': 'x'}
        response = signed_get(client, fake, '/users')
        assert response.status_code == 401

        async def _do(db: Any) -> list[OpenApiLog]:
            stmt = select(OpenApiLog).where(OpenApiLog.access_key == 'fra_ak_PYTEST_unknown')
            return list((await db.execute(stmt)).scalars())

        rows = run_db(_do)
        assert len(rows) == 1
        assert (rows[0].app_id, rows[0].error_code) == (None, 'open.invalid_key')

    def test_rate_limited_per_app(self, client: TestClient, token_headers: dict, rate_limiter: None) -> None:
        issued = create_app(client, token_headers, rate_per_minute=2)
        codes = [signed_get(client, issued, '/users', params='limit=1').status_code for _ in range(3)]
        assert codes == [200, 200, 429]
        assert self._last_log(issued['id']).error_code == 'open.rate_limited'
        # 另一个应用有自己的额度，不受影响
        other = create_app(client, token_headers, suffix='B', rate_per_minute=2)
        assert signed_get(client, other, '/users', params='limit=1').status_code == 200


class TestSuccessLog:
    def test_success_log_is_as_detailed_as_opera_log(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        response = signed_get(client, issued, '/users', params='limit=3', extra_headers={'User-Agent': 'okhttp/4.12.0'})
        assert response.status_code == 200
        log = logs_of(issued['id'])[-1]
        assert (log.status, log.error_code, log.code) == (1, 'ok', '200')
        assert (log.app_code, log.app_name, log.access_key) == (issued['code'], '测试系统', issued['access_key'])
        assert (log.scope, log.scope_granted, log.ip_whitelisted) == ('user:read', True, True)
        assert log.title == '读取用户（增量同步）'
        assert log.row_count == len(response.json()['data']['items']) == 3
        assert log.args == {'query_params': {'limit': '3'}}
        assert log.user_agent == 'okhttp/4.12.0'
        assert response.json()['data']['items'][0]['id'] in log.response_body
        assert log.response_headers['content-type'].startswith('application/json')
        assert issued['secret_key'] not in str(log.request_headers) + (log.response_body or '')

    def test_last_used_time_is_written(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        assert client.get(f'{MGMT}/{issued["id"]}', headers=token_headers).json()['data']['last_used_time'] is None
        signed_get(client, issued, '/users', params='limit=1')
        assert client.get(f'{MGMT}/{issued["id"]}', headers=token_headers).json()['data']['last_used_time']

    def test_log_list_filters(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        signed_get(client, issued, '/users', params='limit=1')
        signed_get(client, issued, '/users', secret='fra_sk_wrong')
        base = {'app_id': issued['id'], 'size': 50}
        everything = client.get('/open-api-logs', headers=token_headers, params=base).json()['data']
        failed = client.get('/open-api-logs', headers=token_headers, params={**base, 'status': 0}).json()['data']
        by_code = client.get(
            '/open-api-logs', headers=token_headers, params={**base, 'error_code': 'open.sign_mismatch'}
        ).json()['data']
        assert everything['total'] == 2
        assert failed['total'] == by_code['total'] == 1
        assert isinstance(everything['items'][0]['id'], str), 'ID 一律字符串下发（硬纪律 6）'


class TestIncrementalSync:
    def _drain(
        self,
        client: TestClient,
        issued: dict,
        path: str,
        cursor: str | None,
        limit: int = 2,
        since: str | None = None,
    ) -> tuple[list, str | None]:
        """翻到底，返回所有条目和最后一个游标。游标不前进就当场红 —— 不加这一句，那个 bug 的表现是 CI 挂死"""
        items: list = []
        last = cursor
        for _ in range(500):
            params = (
                f'limit={limit}' + (f'&updated_since={since}' if since else '') + (f'&cursor={last}' if last else '')
            )
            data = signed_get(client, issued, path, params=params).json()['data']
            items += data['items']
            if not data['has_more']:
                return items, (data['next_cursor'] or last)
            assert data['next_cursor'] != last, f'游标没有前进（同一页会被无限返回）：{last}'
            last = data['next_cursor']
        raise AssertionError('翻了 500 页还没到底')

    def test_paging_is_complete_and_has_no_duplicates(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        everything = signed_get(client, issued, '/depts', params='limit=500').json()['data']['items']
        paged, _ = self._drain(client, issued, '/depts', None, limit=2)
        assert len(everything) >= 3, '前置：种子里至少有几个部门，翻页才有意义'
        assert [d['id'] for d in paged] == [d['id'] for d in everything]
        assert all(
            isinstance(d['id'], str) and (d['parent_id'] is None or isinstance(d['parent_id'], str)) for d in paged
        )

    def test_sub_microsecond_timestamps_do_not_stall_the_cursor(self, client: TestClient, token_headers: dict) -> None:
        """🔴 SQL Server 存到 100ns、Python 只到 µs：同一个时间戳上翻页，游标停在原地、同一页无限返回。

        种子的 `GETDATE()` 落在 `.xx3` / `.xx7` 毫秒时才会这样（三分之二的概率），所以上面那条是**偶发**挂死的；
        这里把三行的时间显式写成带第 7 位小数的同一个值，每次都踩得到。其他方言存不下那一位，这条照样要过。
        """
        issued = create_app(client, token_headers)
        ids: list[int] = []
        try:
            for i in range(3):
                code = f'{CODE_PREFIX}NS{i}'
                body = {'code': code, 'name': f'{CODE_PREFIX}纳秒{i}', 'status': 1, 'sort': 0}
                assert client.post('/sys/depts', headers=token_headers, json=body).json()['code'] == 200
                ids.append(run_db(lambda db, code=code: _dept_id(db, code)))
            run_db(lambda db: _stamp_sub_microsecond(db, ids))
            paged, _ = self._drain(client, issued, '/depts', None, limit=1, since='2099-01-01T00:00:00Z')
            assert [d['id'] for d in paged] == [str(pk) for pk in sorted(ids)]
        finally:
            for pk in ids:
                run_db(lambda db, pk=pk: _hard_delete_dept(db, pk))

    def test_inserts_and_soft_deletes_show_up_after_the_cursor(self, client: TestClient, token_headers: dict) -> None:
        """🔴 新插入的行 updated_time 是 NULL（只按它查会漏掉）；软删的行要以 deleted=true 再出现一次"""
        issued = create_app(client, token_headers)
        # 「从现在往后」的游标：拿当前最后一条自己编一个
        last = signed_get(client, issued, '/depts', params='limit=500').json()['data']['items'][-1]
        cursor = encode_cursor(datetime.fromisoformat(last['updated_time'] or last['created_time']), int(last['id']))

        created = client.post(
            '/sys/depts',
            headers=token_headers,
            json={'code': f'{CODE_PREFIX}SYNC', 'name': f'{CODE_PREFIX}同步测试', 'status': 1, 'sort': 0},
        ).json()
        assert created['code'] == 200, created
        dept_id = run_db(lambda db: _dept_id(db, f'{CODE_PREFIX}SYNC'))
        try:
            after_insert, cursor2 = self._drain(client, issued, '/depts', cursor)
            assert [d['id'] for d in after_insert] == [str(dept_id)]
            assert after_insert[0]['updated_time'] is None and after_insert[0]['deleted'] is False

            assert client.delete(f'/sys/depts/{dept_id}', headers=token_headers).json()['code'] == 200
            after_delete, _ = self._drain(client, issued, '/depts', cursor2)
            assert [(d['id'], d['deleted']) for d in after_delete] == [(str(dept_id), True)]
        finally:
            run_db(lambda db: _hard_delete_dept(db, dept_id))

    def test_bad_cursor_is_a_clear_error(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        response = signed_get(client, issued, '/users', params='cursor=not-a-cursor')
        assert response.status_code == 400
        assert logs_of(issued['id'])[-1].error_code == 'open.bad_cursor'

    def test_user_fields_are_only_the_promised_ones(self, client: TestClient, token_headers: dict) -> None:
        issued = create_app(client, token_headers)
        item = signed_get(client, issued, '/users', params='limit=1').json()['data']['items'][0]
        assert set(item) == {
            'id',
            'username',
            'nickname',
            'dept_id',
            'status',
            'deleted',
            'created_time',
            'updated_time',
        }


async def _dept_id(db: Any, code: str) -> int:
    return (await db.execute(select(Dept.id).where(Dept.code == code))).scalar_one()


async def _hard_delete_dept(db: Any, pk: int) -> None:
    await db.execute(delete(Dept).where(Dept.id == pk))


async def _stamp_sub_microsecond(db: Any, pks: list[int]) -> None:
    """三行写成同一个时间；SQL Server 上带第 7 位小数（Python 的 datetime 表达不了，只能在 SQL 里写）"""
    if db.get_bind().dialect.name == 'mssql':
        value: Any = literal_column("CAST('2099-01-01T00:00:00.1234567+00:00' AS DATETIMEOFFSET(7))")
    else:
        value = datetime.fromisoformat('2099-01-01T00:00:00.123456+00:00')
    await db.execute(update(Dept).where(Dept.id.in_(pks)).values(created_time=value, updated_time=None))


def test_expired_message_shows_server_local_time(client: TestClient, token_headers: dict) -> None:
    """过期提示里的时间要按服务端时区显示 —— 库里读出来是 UTC，直接 to_str 会差 8 小时"""
    from backend.core.conf import settings

    expire = timezone.now() - timedelta(minutes=1)
    issued = create_app(client, token_headers, suffix='TZ', expire_time=expire.astimezone(UTC).isoformat())
    msg = signed_get(client, issued, '/users').json()['msg']
    assert timezone.to_str(timezone.from_datetime(expire)) in msg, (msg, settings.DATETIME_TIMEZONE)
