"""发起时自动填单接真模型跑（#111 第 3 条的验收）。

没配 `AI_TEST_BASE_URL` / `AI_TEST_API_KEY` / `AI_TEST_MODEL` 就整个跳过。

两种材料：一段话（相对日期要按今天换算）· 一张现画的发票图（PIL + 本机的中文字体，没有中文字体就跳过）。
断言只卡「填对了的那几个值」和「材料里没有的不编」；加 `-s` 看模型实际填了什么。
"""

import io
import json
import os

from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.plugin.ai.llm.client import OpenAICompatClient
from backend.plugin.workflow.service import ai_fill_service
from backend.plugin.workflow.tests.conftest import ok
from backend.plugin.workflow.tests.test_ai_fill import FORM, _fill, _flow
from backend.plugin.workflow.tests.test_review_fixes import _publish
from backend.utils.timezone import timezone

_BASE_URL = os.environ.get('AI_TEST_BASE_URL', '').strip()
_API_KEY = os.environ.get('AI_TEST_API_KEY', '').strip()
_MODEL = os.environ.get('AI_TEST_MODEL', '').strip()
_FONTS = [
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/PingFang.ttc',
]

pytestmark = pytest.mark.skipif(
    not (_BASE_URL and _API_KEY and _MODEL),
    reason='没配 AI_TEST_BASE_URL / AI_TEST_API_KEY / AI_TEST_MODEL，不跑真模型',
)


@pytest.fixture(scope='module')
def flow(client: TestClient, token_headers: dict[str, str], uid: Any) -> str:
    _publish(client, token_headers, 'PYTEST_AIF_REAL', FORM, _flow(uid))
    return 'PYTEST_AIF_REAL'


@pytest.fixture(autouse=True)
def _real_model(monkeypatch: pytest.MonkeyPatch) -> None:
    async def build(_db: Any) -> OpenAICompatClient:  # ruff: ignore[unused-async] —— 顶掉的原函数是 async
        return OpenAICompatClient(
            base_url=_BASE_URL, api_key=_API_KEY, model=_MODEL, timeout=120, verify_ssl=False, use_proxy=False
        )

    monkeypatch.setattr(ai_fill_service, 'build_client', build)


def _invoice_png() -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    font_path = next((p for p in _FONTS if Path(p).exists()), None)
    if font_path is None:
        pytest.skip('本机没有中文字体，画不了发票')
    img = Image.new('RGB', (900, 520), 'white')
    draw = ImageDraw.Draw(img)
    big, font = ImageFont.truetype(font_path, 34), ImageFont.truetype(font_path, 24)
    draw.text((250, 30), '上海增值税电子普通发票', fill='black', font=big)
    lines = [
        '发票号码：31245678    开票日期：2026年10月20日',
        '购买方：示例科技有限公司',
        '项目名称：*运输服务*客运服务费（出租车）',
        '金额：¥83.98    税率：3%    税额：¥2.52',
        '价税合计（大写）：捌拾陆元伍角整    （小写）¥86.50',
        '销售方：上海示例出租汽车有限公司',
    ]
    for i, line in enumerate(lines):
        draw.text((40, 120 + i * 60), line, fill='black', font=font)
    draw.rectangle((20, 100, 880, 500), outline='black', width=2)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def _show(data: dict[str, Any]) -> None:
    print(f'\n[{_MODEL}] 填了 {json.dumps(data["values"], ensure_ascii=False)}')
    print(f'  没填 / 丢掉 {[(s["field_id"], s["reason"]) for s in data["skipped"]]}')


def test_a_paragraph_with_relative_dates(client: TestClient, login: Any, flow: str) -> None:
    today = timezone.now().date()
    monday = today + timedelta(days=7 - today.weekday())
    res = _fill(client, login('sunqiang'), flow, words='下周一到周三去上海见客户谈续约，坐火车去，车票大概 553 块')
    data = ok(res)
    _show(data)
    values = data['values']
    assert '上海' in values.get('f_reason', ''), values
    assert values.get('f_range') == [monday.isoformat(), (monday + timedelta(days=2)).isoformat()], values
    assert values.get('f_kind') == 'train', values
    # 材料里没有开票日期：不许编
    assert 'f_date' not in values, values


def test_an_invoice_image(client: TestClient, login: Any, flow: str) -> None:
    """视觉模型：按发票填金额 / 日期 / 类别。不认图的模型要么报错、要么什么都不填 —— 绝不能编出一个金额"""
    res = _fill(client, login('sunqiang'), flow, file=('发票.png', _invoice_png(), 'image/png'))
    print(f'\n[{_MODEL}] 状态 {res.status_code}：{res.text[:300]}')
    if res.status_code != 200:
        assert res.json()['msg'], '读不了图要说清楚'
        return
    data = res.json()['data']
    _show(data)
    values = data['values']
    if not values:
        return
    assert values.get('f_amount') in (None, '86.50'), f'金额编错了：{values}'
    assert values.get('f_date') in (None, '2026-10-20'), values
    if 'vl' in _MODEL.lower():
        assert values.get('f_amount') == '86.50' and values.get('f_date') == '2026-10-20', values
        assert values.get('f_kind') == 'taxi', values
