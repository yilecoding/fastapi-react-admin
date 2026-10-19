"""天气工具 —— 这个插件里**第一个往系统外发请求**的工具。

和前面 8 个工具是两类东西，差异值得写下来：

| | 系统内工具（role_list 等） | 外部工具（这个） |
|---|---|---|
| 数据来源 | 自己的库 | 第三方 HTTP 服务 |
| 权限 | 复用现成权限码 | **挂不上任何权限码**——它不读系统数据 |
| 失败模式 | 数据库错误（快、可控） | 超时 / DNS / 代理 / 对方限流（慢、不可控） |
| 数据范围 | 自动继承调用者 | 不适用 |

用 Open-Meteo：**免 API key**，所以不用再引一套密钥管理。
"""

from typing import Any

import httpx

from backend.common.log import log
from backend.core.conf import settings
from backend.plugin.ai.core.registry import ai_tool

_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

# WMO 天气代码 → 中文。不翻译的话模型看到的是一个裸数字，
# 它多半会自己猜一个含义 —— 猜错了没人看得出来
_WMO: dict[int, str] = {
    0: '晴',
    1: '大部晴朗',
    2: '多云',
    3: '阴',
    45: '雾',
    48: '雾凇',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '大毛毛雨',
    56: '冻毛毛雨',
    57: '强冻毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    66: '冻雨',
    67: '强冻雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    77: '雪粒',
    80: '阵雨',
    81: '强阵雨',
    82: '暴雨',
    85: '阵雪',
    86: '强阵雪',
    95: '雷阵雨',
    96: '雷阵雨伴小冰雹',
    99: '雷阵雨伴大冰雹',
}


def _client() -> httpx.AsyncClient:
    """外部调用的 HTTP 客户端。

    🔴 `trust_env` 默认 **True**（和 LLM 客户端相反）。理由不一样：
    LLM 网关那边是"照抄某台机器的既有行为"，而一个通用的外部服务调用，
    正确的默认是**尊重环境里配了什么**——没配代理时 `trust_env=True` 就是直连，
    配了就走代理。实测本机：直连 open-meteo 超时 12 秒，走企业代理 200。
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.AI_EXTERNAL_HTTP_TIMEOUT),
        trust_env=settings.AI_EXTERNAL_HTTP_USE_PROXY,
    )


@ai_tool(
    name='weather_query',
    description=(
        '查询某个城市的实时天气（温度、湿度、风速、天气状况）。'
        '用户问"XX 天气怎么样""今天冷不冷"时用它。城市名用中文或英文都行。'
    ),
    domain='weather',
    # perm=None：它不读系统里的任何数据，挂权限码没有意义。
    # 想限制谁能用，靠 `AI_TOOL_DOMAINS` 整域开关即可。
    perm=None,
)
async def weather_query(city: str) -> dict[str, Any]:
    async with _client() as client:
        try:
            geo = await client.get(_GEOCODE_URL, params={'name': city, 'count': 1, 'language': 'zh'})
            geo.raise_for_status()
            places = (geo.json() or {}).get('results') or []
            if not places:
                # 查不到城市不是异常，是一个要如实告诉模型的结果 ——
                # 抛异常的话模型只会看到"执行失败"，没法建议用户换个写法
                return {'ok': False, 'reason': f'没有找到城市「{city}」，换个写法试试（如"深圳"或"Shenzhen"）'}

            place = places[0]
            forecast = await client.get(
                _FORECAST_URL,
                params={
                    'latitude': place['latitude'],
                    'longitude': place['longitude'],
                    'current': 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature',
                    'timezone': 'auto',
                },
            )
            forecast.raise_for_status()
            current = (forecast.json() or {}).get('current') or {}
        except httpx.TimeoutException:
            return {'ok': False, 'reason': f'天气服务超时（{settings.AI_EXTERNAL_HTTP_TIMEOUT} 秒）'}
        except httpx.HTTPError as e:
            log.warning(f'天气查询失败：{e}')
            return {'ok': False, 'reason': f'天气服务不可用：{e}'}

    code = current.get('weather_code')
    return {
        'ok': True,
        'city': place.get('name'),
        'admin_area': place.get('admin1'),
        'country': place.get('country'),
        'observed_at': current.get('time'),
        'temperature_c': current.get('temperature_2m'),
        'feels_like_c': current.get('apparent_temperature'),
        'humidity_percent': current.get('relative_humidity_2m'),
        'wind_speed_kmh': current.get('wind_speed_10m'),
        'condition': _WMO.get(code, f'未知（WMO {code}）'),
        'weather_code': code,
    }
