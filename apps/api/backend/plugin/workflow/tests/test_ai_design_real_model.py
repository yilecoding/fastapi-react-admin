"""设计器一句话生成接真模型跑（#111 第 1 条的验收）。

没配 `AI_TEST_BASE_URL` / `AI_TEST_API_KEY` / `AI_TEST_MODEL` 就整个跳过。

`test_ai_design.py` 的模型是假的，验的是我们的把关；这里验的是真模型读了从 schema 生成的目录之后，
能不能产出**能发布**的定义。断言只卡结构（有明细表 / 合计是按列算的 / 有按合计分的支），不卡措辞和 ID；
加 `-s` 看模型实际给了什么。
"""

import json
import os

from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.plugin.ai.llm.client import OpenAICompatClient
from backend.plugin.workflow.engine.flow import index_nodes
from backend.plugin.workflow.service import ai_design_service
from backend.plugin.workflow.tests.conftest import ok
from backend.plugin.workflow.tests.test_ai_design import _definition, _generate

_BASE_URL = os.environ.get('AI_TEST_BASE_URL', '').strip()
_API_KEY = os.environ.get('AI_TEST_API_KEY', '').strip()
_MODEL = os.environ.get('AI_TEST_MODEL', '').strip()

pytestmark = pytest.mark.skipif(
    not (_BASE_URL and _API_KEY and _MODEL),
    reason='没配 AI_TEST_BASE_URL / AI_TEST_API_KEY / AI_TEST_MODEL，不跑真模型',
)


@pytest.fixture(autouse=True)
def _real_model(monkeypatch: pytest.MonkeyPatch) -> None:
    async def build(_db: Any) -> OpenAICompatClient:  # ruff: ignore[unused-async] —— 顶掉的原函数是 async
        return OpenAICompatClient(
            base_url=_BASE_URL, api_key=_API_KEY, model=_MODEL, timeout=120, verify_ssl=False, use_proxy=False
        )

    monkeypatch.setattr(ai_design_service, 'build_client', build)


def _show(data: dict[str, Any]) -> None:
    issues = [(i['code'], i.get('nodeId') or i.get('fieldId')) for i in data['issues']]
    print(f'\n[{_MODEL}] 轮数 {data["rounds"]}，问题 {issues}')
    print(json.dumps({'form': data['form'], 'model': data['model']}, ensure_ascii=False)[:3000])


def test_the_purchase_example_from_the_issue(client: TestClient, token_headers: dict[str, str]) -> None:
    """#111 里的原句：明细 + 合计自动算 + 超过 1 万走财务总监"""
    pk = _definition(client, token_headers, 'PYTEST_AID_REAL_BUY')
    data = ok(
        _generate(
            client,
            token_headers,
            pk,
            '做一个采购申请：物品明细（名称 / 数量 / 单价），合计自动算；超过 1 万走财务总监',
        )
    )
    _show(data)
    # 「财务总监」测试库里没有这个角色：模型要么用部门负责人、要么留空 —— 留空就是 APPROVER_EMPTY，那是给人的
    assert [i for i in data['issues'] if i['level'] == 'ERROR' and i['code'] != 'APPROVER_EMPTY'] == []
    fields = {f['id']: f for f in data['form']['fields']}
    tables = [f for f in fields.values() if f['type'] == 'table']
    assert tables, '物品明细应该是明细表'
    sums = [f for f in fields.values() if (f.get('calc') or {}).get('kind') == 'sum']
    assert sums and sums[0]['calc']['field'] == tables[0]['id'], '合计应该是对明细表一列的自动合计'
    summed = next(c for c in tables[0]['columns'] if c['id'] == sums[0]['calc']['column'])
    # 能发布但算错的那种：两个模型第一版都对「单价」列求和（没有乘法，提示词里写明了要加一列金额）
    assert '单价' not in summed['label'], f'合计了单价列：{tables[0]["columns"]}'
    conditions = [r.node for r in index_nodes(data['model']).values() if r.node['type'] == 'condition']
    assert conditions, '超过 1 万要有条件分支'
    when_vars = {
        b['when'].get('var') for c in conditions for b in c['branches'] if b.get('when') and not b['when'].get('all')
    }
    assert sums[0]['id'] in when_vars, f'分支应该按合计判断：{when_vars}'


def test_leave_with_named_steps(client: TestClient, token_headers: dict[str, str]) -> None:
    """常见的第二种说法：按天数分级、附件按类型出现"""
    pk = _definition(client, token_headers, 'PYTEST_AID_REAL_LEAVE')
    data = ok(
        _generate(
            client,
            token_headers,
            pk,
            '出差申请：目的地、出差日期区间、天数自动算、预算金额、事由；预算超过 5000 要部门负责人的上一级再审一次',
        )
    )
    _show(data)
    assert [i for i in data['issues'] if i['level'] == 'ERROR' and i['code'] != 'APPROVER_EMPTY'] == []
    fields = data['form']['fields']
    assert any((f.get('calc') or {}).get('kind') == 'days' for f in fields), '天数应该自动算'
    assert any(f['type'] == 'amount' for f in fields), '预算是金额'
