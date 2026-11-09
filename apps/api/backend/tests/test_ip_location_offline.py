"""离线 IP 属地：IPv6 / IPv4 映射地址（上游 adb4b94 的同类问题，只做了不带 v6 库的那一半）

修之前实测：`::ffff:114.114.114.114`、`2408:8207:1234::1`、`::1` 全部
`ValueError: invalid ip address … (IPv4 expected)`，每个请求打一条 error 日志。
"""

import pytest

from backend.utils import request_parse


class _RecordingLog:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def __getattr__(self, name: str) -> object:
        return lambda *args, **kwargs: None


@pytest.fixture
def recording_log(monkeypatch: pytest.MonkeyPatch) -> _RecordingLog:
    fake = _RecordingLog()
    monkeypatch.setattr(request_parse, 'log', fake)
    return fake


def test_ipv4(recording_log: _RecordingLog) -> None:
    location = request_parse.get_location_offline('114.114.114.114')
    assert location == {'country': '中国', 'regionName': '江苏省', 'city': '南京市'}
    assert recording_log.errors == []


def test_ipv4_mapped_ipv6_is_looked_up_as_ipv4(recording_log: _RecordingLog) -> None:
    """双栈代理后面常见 `::ffff:a.b.c.d`：按 IPv4 查，结果和裸 IPv4 一样"""
    assert request_parse.get_location_offline('::ffff:114.114.114.114') == request_parse.get_location_offline(
        '114.114.114.114'
    )
    assert recording_log.errors == []


@pytest.mark.parametrize('ip', ['2408:8207:1234::1', '::1'])
def test_real_ipv6_returns_none_without_logging_an_error(recording_log: _RecordingLog, ip: str) -> None:
    """没有 IPv6 的库：返回 None 是预期结果，不是错误，不能每个请求刷一条 error"""
    assert request_parse.get_location_offline(ip) is None
    assert recording_log.errors == []


def test_garbage_is_still_reported(recording_log: _RecordingLog) -> None:
    """真不是 IP 的串说明上游取 IP 的逻辑出了问题，这个要报"""
    assert request_parse.get_location_offline('not-an-ip') is None
    assert len(recording_log.errors) == 1
