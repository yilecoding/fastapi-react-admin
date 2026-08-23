from functools import lru_cache
from ipaddress import IPv4Network, IPv6Network, ip_address, ip_network

import httpx
import ip2region.searcher as ip2region_xdb
import ip2region.util as ip2region_util

from fastapi import Request
from user_agents import parse

from backend.common.dataclasses import IpInfo, UserAgentInfo
from backend.common.log import log
from backend.core.conf import settings
from backend.core.path_conf import STATIC_DIR
from backend.database.redis import redis_client


def _parse_network(item: str) -> IPv4Network | IPv6Network | None:
    """解析单个 IP / CIDR，失败返回 None"""
    try:
        return ip_network(item.strip(), strict=False)
    except ValueError:
        log.warning(f'TRUSTED_PROXIES 里有无法解析的地址，已忽略：{item}')
        return None


@lru_cache(maxsize=1)
def _trusted_proxy_networks(raw: tuple[str, ...]) -> tuple[IPv4Network | IPv6Network, ...]:
    """把配置里的 IP / CIDR 串解析成网段（配置不变时只解析一次）"""
    return tuple(n for n in map(_parse_network, raw) if n is not None)


def _is_trusted_proxy(host: str) -> bool:
    """判断直连对端是不是我们自己的反向代理"""
    networks = _trusted_proxy_networks(tuple(settings.TRUSTED_PROXIES))
    if not networks:
        return False
    try:
        addr = ip_address(host)
    except ValueError:
        return False
    return any(addr in net for net in networks)


def get_request_ip(request: Request) -> str:
    """
    获取请求的 IP 地址

    🔴 **只有直连对端是可信代理时才采信转发头。**

    `X-Real-IP` / `X-Forwarded-For` 是客户端可以随便填的。而这个函数的返回值
    决定了限流的 key（`utils/limiter.py: default_identifier` = `{IP}:{path}`）、
    登录日志的来源和 IP 属地 —— 无条件信任它们，等于每换一个 header 就发一份
    新的限流配额，登录爆破和验证码刷取全部无损通过，且日志里的 IP 全是伪造的。
    这个失败是**完全静默**的：限流看起来在工作，日志看起来也正常。

    可信范围配在 `TRUSTED_PROXIES`，默认空 —— 直连场景下就该只认对端地址。
    采信时从右往左取第一个**不是**可信代理的地址：XFF 是追加的，右侧才是
    离我们最近、由可信代理写上去的部分，左侧可以被客户端预填。

    :param request: FastAPI 请求对象
    :return:
    """
    if request.client is None:
        return '127.0.0.1'

    # 忽略 pytest
    peer = request.client.host
    if peer == 'testclient':
        return '127.0.0.1'

    if not _is_trusted_proxy(peer):
        return peer

    forwarded = request.headers.get('X-Forwarded-For')
    if forwarded:
        for candidate in reversed([h.strip() for h in forwarded.split(',') if h.strip()]):
            if not _is_trusted_proxy(candidate):
                return candidate

    real = request.headers.get('X-Real-IP')
    if real:
        return real.strip()

    return peer


async def get_location_online(ip: str) -> dict | None:
    """
    在线获取 IP 地址属地，无法保证可用性，准确率较高

    :param ip: IP 地址
    :return:
    """
    async with httpx.AsyncClient(timeout=3) as client:
        try:
            response = await client.get(f'http://ip-api.com/json/{ip}?lang=zh-CN')
            if response.status_code == 200:
                return response.json()
        except Exception as e:
            log.error(f'在线获取 IP 地址属地失败，错误信息：{e}')
            return None


# 离线 IP 搜索器（数据将缓存到内存，缓存大小取决于 IP 数据文件大小）
__c_buffer: bytes = ip2region_util.load_content_from_file(STATIC_DIR / 'ip2region_v4.xdb')
__xdb_searcher: ip2region_xdb.Searcher = ip2region_xdb.new_with_buffer(ip2region_util.IPv4, __c_buffer)


def get_location_offline(ip: str) -> dict | None:
    """
    离线获取 IP 地址属地，无法保证准确率，100% 可用

    :param ip: IP 地址
    :return:
    """
    try:
        data = __xdb_searcher.search(ip)
        country, region_name, city, *_ = data.split('|')
    except Exception as e:
        log.error(f'离线获取 IP 地址属地失败：{e}')
        return None
    else:
        return {
            'country': country if country != '0' else None,
            'regionName': region_name if region_name != '0' else None,
            'city': city if city != '0' else None,
        }


async def parse_ip_info(request: Request) -> IpInfo:
    """
    解析请求的 IP 信息

    :param request: FastAPI 请求对象
    :return:
    """
    country, region, city = None, None, None
    ip = get_request_ip(request)
    location = await redis_client.get(f'{settings.IP_LOCATION_REDIS_PREFIX}:{ip}')
    if location:
        country, region, city = location.split('|')
        return IpInfo(ip=ip, country=country, region=region, city=city)

    location_info = None
    if settings.IP_LOCATION_PARSE == 'online':
        location_info = await get_location_online(ip)
    elif settings.IP_LOCATION_PARSE == 'offline':
        location_info = get_location_offline(ip)

    if location_info:
        country = location_info.get('country')
        region = location_info.get('regionName')
        city = location_info.get('city')
        await redis_client.set(
            f'{settings.IP_LOCATION_REDIS_PREFIX}:{ip}',
            f'{country}|{region}|{city}',
            ex=settings.IP_LOCATION_EXPIRE_SECONDS,
        )
    return IpInfo(ip=ip, country=country, region=region, city=city)


def parse_user_agent_info(request: Request) -> UserAgentInfo:
    """
    解析请求的用户代理信息

    :param request: FastAPI 请求对象
    :return:
    """
    os, browser, device = None, None, None
    user_agent = request.headers.get('User-Agent')
    if user_agent:
        user_agent_ = parse(user_agent)
        os = user_agent_.get_os()
        browser = user_agent_.get_browser()
        device = user_agent_.get_device()
    return UserAgentInfo(user_agent=user_agent, device=device, os=os, browser=browser)
