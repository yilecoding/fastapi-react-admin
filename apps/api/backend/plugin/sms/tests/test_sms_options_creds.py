"""迁移 `ar000000smsoptcreds`：已经把凭据存进 `options` 的旧配置要清掉（#284 评审）。

保存时现在拒收，但之前存进去的行还在：详情接口原样下发明文，改那一行时旧 `options` 以明文进数据变更记录，
那一行在界面上每次保存都 400。直接往库里垫行（接口现在存不进去），跑清理函数，再读回来。
"""

import json
import random
import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from backend.plugin.sms.model import SmsConfig
from backend.plugin.sms.service.config_service import strip_credential_options
from backend.tests.utils.data_change import engine
from backend.utils.timezone import timezone

_RUN = uuid.uuid4().hex[:8]
_BASE_ID = random.randint(8_100_000_000_000_000_000, 8_200_000_000_000_000_000)
#: name → (厂商, options)
ROWS = {
    'smuggled': ('aliyun', {'endpoint': 'dysmsapi.aliyuncs.com', 'access_key_secret': 'leak-in-options'}),
    'clean': ('aliyun', {'endpoint': 'dysmsapi.aliyuncs.com'}),
    'unknown': ('no-such-provider', {'secret_key': 'unknown-provider-key'}),
}


def _options() -> dict[str, dict]:
    table = SmsConfig.__table__
    with engine().connect() as conn:
        rows = conn.execute(sa.select(table.c.name, table.c.options).where(table.c.name.like(f'pytest-oc-{_RUN}-%')))
        return {r.name.rsplit('-', 1)[1]: json.loads(r.options) for r in rows}


@pytest.fixture
def legacy_rows() -> Iterator[None]:
    now = timezone.now()
    table = SmsConfig.__table__
    rows = [
        {
            'id': _BASE_ID + i,
            'name': f'pytest-oc-{_RUN}-{name}',
            'provider': provider,
            'sign_name': '测试签名',
            'options': json.dumps(options),
            'templates': '{}',
            'access_key_id': 'LTAI-pytest',
            'secret_cipher': None,
            'secret_mask': None,
            'weight': 0,
            'daily_max': 0,
            'timeout': 10,
            'is_default': False,
            'status': 0,
            'remark': None,
            'created_by': None,
            'created_time': now,
            'updated_time': None,
            'deleted': 0,
            'deleted_time': None,
        }
        for i, (name, (provider, options)) in enumerate(ROWS.items())
    ]
    with engine().begin() as conn:
        conn.execute(sa.insert(table), rows)
    try:
        yield
    finally:
        with engine().begin() as conn:
            conn.execute(sa.delete(table).where(table.c.name.like(f'pytest-oc-{_RUN}-%')))


@pytest.mark.usefixtures('legacy_rows')
def test_credentials_already_in_options_are_stripped() -> None:
    assert _options()['smuggled']['access_key_secret'] == 'leak-in-options'  # 先断言「有」

    with engine().begin() as conn:
        changed, skipped = strip_credential_options(conn)
    after = _options()
    assert after['smuggled'] == {'endpoint': 'dysmsapi.aliyuncs.com'}, '凭据去掉、别的配置留着'
    assert after['clean'] == ROWS['clean'][1]
    assert after['unknown'] == ROWS['unknown'][1], '认不出的厂商不知道哪些是凭据，不动'
    # 共享的测试库里可能还有别的行，所以只能断言「至少」
    assert changed >= 1 and skipped >= 1

    with engine().begin() as conn:
        strip_credential_options(conn)
    assert _options() == after, '重跑不再变'
