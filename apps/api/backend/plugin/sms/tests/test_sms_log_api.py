"""发送日志接口：筛选三层对齐、列表掩码 / 详情完整、「发送中」过期判定、删除。"""

from __future__ import annotations

import inspect

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from backend.core.conf import settings
from backend.plugin.sms.api.v1 import log as log_api
from backend.plugin.sms.crud.crud_log import sms_log_dao
from backend.plugin.sms.enums import SmsLogStatus
from backend.plugin.sms.schema.log import mask_phone
from backend.plugin.sms.service.log_service import is_stale
from backend.plugin.sms.tests.conftest import CONFIGS, LOGS, PHONE_A, PHONE_B
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Callable

    import pytest

    from starlette.testclient import TestClient


class TestLogFilterParams:
    """🔴 DAO 收了筛选参数、接口没往下透传 —— FastAPI 会静默丢弃未声明的查询参数（AI 插件那条）"""

    @staticmethod
    def _dao_filters() -> set[str]:
        sig = inspect.signature(sms_log_dao.get_select)
        return {n for n, p in sig.parameters.items() if p.kind is p.KEYWORD_ONLY}

    @staticmethod
    def _route_params() -> set[str]:
        return {n for n in inspect.signature(log_api.get_sms_logs_paginated).parameters if n != 'db'}

    def test_every_dao_filter_is_exposed_by_the_route(self) -> None:
        assert not (self._dao_filters() - self._route_params())

    def test_route_does_not_declare_filters_the_dao_ignores(self) -> None:
        assert not (self._route_params() - self._dao_filters())

    def test_route_forwards_every_filter(self) -> None:
        source = inspect.getsource(log_api.get_sms_logs_paginated)
        missing = [p for p in self._dao_filters() if f'{p}={p}' not in source]
        assert not missing, f'接口声明了但没往 service 传：{missing}'


def _send_test(client: TestClient, headers: dict[str, str], config_id: str, phone: str, code: str) -> dict[str, Any]:
    res = client.post(
        f'{CONFIGS}/{config_id}/test',
        headers=headers,
        json={'phone': phone, 'template_id': 'X', 'params': {'code': code}},
    )
    assert res.json()['code'] == 200, res.text
    return res.json()['data']


class TestListAndDetail:
    def test_list_masks_phone_and_detail_shows_it(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        cfg = make_config('log')
        sent = _send_test(client, token_headers, cfg['id'], PHONE_A, '4321')
        listing = client.get(LOGS, headers=token_headers, params={'phone': PHONE_A}).json()['data']
        assert listing['total'] == 1
        item = listing['items'][0]
        assert item['phone'] == '199****0001'
        # 分页的 links 会把查询参数原样回显（那是调用方自己传的），所以只看每一行的字段值
        assert not [k for k, v in item.items() if isinstance(v, str) and PHONE_A in v], item
        assert item['id'] == sent['log_id'] and item['config_id'] == cfg['id'] and item['stale'] is False
        assert '4321' in item['params'], '测试短信的参数不打码（人填的就是要看的）'
        detail = client.get(f'{LOGS}/{sent["log_id"]}', headers=token_headers).json()['data']
        assert detail['phone'] == PHONE_A and detail['template'] == 'test' and detail['status'] == 1

    def test_filters_reach_the_sql(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        cfg = make_config('flt')
        _send_test(client, token_headers, cfg['id'], PHONE_A, '1')
        _send_test(client, token_headers, cfg['id'], PHONE_B, '2')
        get = lambda **p: client.get(LOGS, headers=token_headers, params=p).json()['data']['total']  # ruff: ignore[lambda-assignment]
        assert get(phone=PHONE_A) == 1 and get(phone=PHONE_B) == 1
        assert get(phone=PHONE_A, config_id=cfg['id']) == 1
        assert get(phone=PHONE_A, template='test') == 1 and get(phone=PHONE_A, template='captcha') == 0
        assert (
            get(phone=PHONE_A, status=SmsLogStatus.accepted.value) == 1
            and get(phone=PHONE_A, status=SmsLogStatus.failed.value) == 0
        )
        assert get(phone=PHONE_A, error_kind='unknown') == 0
        future = (timezone.now() + timedelta(days=1)).isoformat()
        assert get(phone=PHONE_A, start_time=future) == 0 and get(phone=PHONE_A, end_time=future) == 1

    def test_unknown_log_is_404(self, client: TestClient, token_headers: dict[str, str]) -> None:
        assert client.get(f'{LOGS}/1', headers=token_headers).json()['code'] == 404


class TestDelete:
    def test_batch_delete(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        cfg = make_config('rm')
        a = _send_test(client, token_headers, cfg['id'], PHONE_A, '1')['log_id']
        b = _send_test(client, token_headers, cfg['id'], PHONE_B, '2')['log_id']
        assert client.get(LOGS, headers=token_headers, params={'phone': PHONE_A}).json()['data']['total'] == 1, (
            '前置：有'
        )
        res = client.request('DELETE', LOGS, headers=token_headers, json={'pks': [a]})
        assert res.json()['code'] == 200
        assert client.get(LOGS, headers=token_headers, params={'phone': PHONE_A}).json()['data']['total'] == 0
        assert client.get(f'{LOGS}/{b}', headers=token_headers).json()['code'] == 200, '没点名的那条还在'
        assert client.request('DELETE', LOGS, headers=token_headers, json={'pks': [a]}).json()['code'] == 400


class TestStale:
    def test_mask_phone(self) -> None:
        assert mask_phone('13800000000') == '138****0000'
        assert mask_phone('12345') == '*****'

    def test_is_stale_only_for_old_sending_rows(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, 'SMS_SENDING_STALE_SECONDS', 60)
        now = timezone.now()
        assert is_stale(SmsLogStatus.sending.value, now - timedelta(seconds=61))
        assert not is_stale(SmsLogStatus.sending.value, now - timedelta(seconds=10))
        assert not is_stale(SmsLogStatus.accepted.value, now - timedelta(days=1))
        assert not is_stale(SmsLogStatus.unknown.value, now - timedelta(days=1))
