#!/usr/bin/env python3
"""压测脚本：对后端的只读接口按固定并发打一段时间，报每个接口的吞吐与延迟分位。

    pnpm loadtest                                   # 默认：本机 :8088，并发 20，跑 30 秒
    pnpm loadtest -c 50 -d 60                       # 并发 50，跑 60 秒
    pnpm loadtest --stages 10,25,50,100 -d 20       # 阶梯加压：每档 20 秒，找拐点
    pnpm loadtest --json out.json                   # 同时写一份 JSON，方便前后对比

它只用后端自带的 httpx（`uv run --project apps/api`），不装任何新依赖。

设计取舍（都是实测踩出来的，不是风格偏好）：

1. 🔴 **只打 GET。** 压测不该在库里造数据，更不该误伤别人的环境。
   非本机地址必须显式加 `--allow-remote`，否则直接退出。
2. 🔴 **登录只做一次，之后复用 token。** `/auth/login` 有 5 次/分钟的限流（按 IP + 路径），
   压测里每个虚拟用户各登一次，第 6 个就是 429，压的就变成限流器了。
3. 🔴 **成败看信封，不只看 HTTP 状态。** 这个后端业务失败有时也回 HTTP 200，
   body 里 `code != 200`（见 `packages/api/AGENTS.md`）。只看状态码会把失败算成成功。
4. **429 单独统计。** 除登录外，写操作和部分接口也有限流；一旦出现 429，
   说明测到的是限流而不是服务能力，报告里会专门提示。
5. 延迟是**客户端侧**测的（含网络与 httpx 开销）。单进程 asyncio 在并发很高时，
   压测机自己会成为瓶颈：看到 CPU 吃满、延迟随并发线性涨但服务端很闲，就该换机器或开多个进程。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import subprocess
import sys
import time

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

# (名字, 路径, 权重)。权重大致模拟后台日常：每次进页面都会拉的先打得多。
# 全部是 GET；`/sys/users` 等分页接口显式带 size，避免默认值变了悄悄改变负载。
ENDPOINTS: list[tuple[str, str, int]] = [
    ('auth.codes', '/auth/codes', 3),
    ('menu.sidebar', '/sys/menus/sidebar', 5),
    ('user.me', '/sys/users/me', 5),
    ('user.list', '/sys/users?page=1&size=20', 4),
    ('role.list', '/sys/roles?page=1&size=20', 2),
    ('dept.tree', '/sys/depts', 2),
    ('menu.tree', '/sys/menus', 1),
    ('dict.all', '/sys/dict-datas/all', 2),
    ('config.all', '/sys/configs/all', 1),
    ('notify.unread', '/sys/notifications/unread-count', 4),
    ('notify.list', '/sys/notifications?page=1&size=20', 2),
    ('file.stats', '/sys/files/statistics', 1),
]

LOCAL_HOSTS = {'127.0.0.1', 'localhost', '::1', '0.0.0.0'}  # noqa: S104


@dataclass
class Stat:
    latencies: list[float] = field(default_factory=list)  # 毫秒，只记成功的
    ok: int = 0
    fail: int = 0
    status: Counter = field(default_factory=Counter)  # HTTP 状态码或 'timeout' / 'conn_error'
    biz_fail: int = 0  # HTTP 200 但信封 code != 200


def percentile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return math.nan
    k = max(0, min(len(sorted_values) - 1, math.ceil(q / 100 * len(sorted_values)) - 1))
    return sorted_values[k]


def captcha_answer_from_redis(container: str, prefix: str, uuid: str, db: int = 0) -> str:
    out = subprocess.run(  # noqa: S603
        ['docker', 'exec', container, 'redis-cli', '-n', str(db), '--raw', 'GET', f'{prefix}:{uuid}'],  # noqa: S607
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    return out.stdout.strip()


async def identify(base_url: str, timeout: float) -> str:
    """服务自报的名字和版本，打在开头。

    🔴 本机 8088 常常是**别的项目**的后端（这个脚本的第一轮试跑就打到了另一个项目，数字全是别人的，
    而且一切正常、没有任何报错）。只有把对方自报的身份摆出来，才看得出打错了。
    生产会关掉 /openapi，拿不到就说拿不到，不影响压测。
    """
    root = base_url.split('/api/', 1)[0] if '/api/' in base_url else base_url.rsplit('/', 1)[0]
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            info = (await c.get(f'{root}/openapi')).json()['info']
        return f'{info["title"]} {info["version"]}'
    except (httpx.HTTPError, ValueError, KeyError):
        return '（/openapi 不可用，认不出对方是谁）'


async def login(client: httpx.AsyncClient, args: argparse.Namespace) -> str:
    """登一次，返回 access_token。验证码开着时从 Redis 读答案（同 CLAUDE.md「本地起服务」）。"""
    body: dict = {'username': args.username, 'password': args.password}
    cap = (await client.get('/auth/captcha')).json().get('data') or {}
    if cap.get('is_enabled'):
        if not args.redis_container:
            sys.exit('登录要验证码，请加 --redis-container fba_redis（从 Redis 读答案），或直接给 --token')
        body['uuid'] = cap['uuid']
        body['captcha'] = captcha_answer_from_redis(args.redis_container, args.captcha_prefix, cap['uuid'], args.redis_db)
    resp = await client.post('/auth/login', json=body)
    payload = resp.json()
    if resp.status_code != 200 or payload.get('code') != 200:
        sys.exit(f'登录失败：HTTP {resp.status_code} {payload.get("msg")}')
    data = payload['data']
    if 'access_token' not in data:
        sys.exit('这个账号开了二步验证（MFA），脚本不处理；请换一个没开的账号，或直接给 --token')
    return data['access_token']


async def worker(
    client: httpx.AsyncClient,
    deadline: float,
    population: list[tuple[str, str]],
    weights: list[int],
    stats: dict[str, Stat],
    think: float,
) -> None:
    while time.perf_counter() < deadline:
        name, path = random.choices(population, weights=weights, k=1)[0]  # noqa: S311
        st = stats[name]
        t0 = time.perf_counter()
        try:
            resp = await client.get(path)
        except httpx.TimeoutException:
            st.fail += 1
            st.status['timeout'] += 1
            continue
        except httpx.HTTPError:
            st.fail += 1
            st.status['conn_error'] += 1
            continue
        elapsed = (time.perf_counter() - t0) * 1000
        st.status[resp.status_code] += 1
        good = resp.status_code == 200
        if good:
            try:
                good = resp.json().get('code') == 200
            except ValueError:
                good = False
            if not good:
                st.biz_fail += 1
        if good:
            st.ok += 1
            st.latencies.append(elapsed)
        else:
            st.fail += 1
        if think:
            await asyncio.sleep(think)


async def run_stage(
    base_url: str,
    token: str,
    concurrency: int,
    duration: float,
    timeout: float,
    think: float,
    endpoints: list[tuple[str, str, int]],
) -> tuple[dict[str, Stat], float]:
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    headers = {'Authorization': f'Bearer {token}'}
    stats: dict[str, Stat] = defaultdict(Stat)
    population = [(n, p) for n, p, _ in endpoints]
    weights = [w for _, _, w in endpoints]
    async with httpx.AsyncClient(
        base_url=base_url, headers=headers, limits=limits, timeout=timeout
    ) as client:
        t0 = time.perf_counter()
        deadline = t0 + duration
        await asyncio.gather(*(worker(client, deadline, population, weights, stats, think) for _ in range(concurrency)))
        return stats, time.perf_counter() - t0


def summarize(stats: dict[str, Stat], elapsed: float) -> dict:
    rows = {}
    total = Stat()
    for name, st in stats.items():
        lat = sorted(st.latencies)
        rows[name] = {
            'requests': st.ok + st.fail,
            'ok': st.ok,
            'fail': st.fail,
            'biz_fail': st.biz_fail,
            'rps': round((st.ok + st.fail) / elapsed, 1),
            'p50': round(percentile(lat, 50), 1),
            'p90': round(percentile(lat, 90), 1),
            'p95': round(percentile(lat, 95), 1),
            'p99': round(percentile(lat, 99), 1),
            'max': round(lat[-1], 1) if lat else math.nan,
            'status': {str(k): v for k, v in st.status.items() if k != 200},
        }
        total.latencies += st.latencies
        total.ok += st.ok
        total.fail += st.fail
        total.biz_fail += st.biz_fail
        total.status.update(st.status)
    lat = sorted(total.latencies)
    rows['__total__'] = {
        'requests': total.ok + total.fail,
        'ok': total.ok,
        'fail': total.fail,
        'biz_fail': total.biz_fail,
        'rps': round((total.ok + total.fail) / elapsed, 1),
        'mean': round(statistics.fmean(lat), 1) if lat else math.nan,
        'p50': round(percentile(lat, 50), 1),
        'p90': round(percentile(lat, 90), 1),
        'p95': round(percentile(lat, 95), 1),
        'p99': round(percentile(lat, 99), 1),
        'max': round(lat[-1], 1) if lat else math.nan,
        'status': {str(k): v for k, v in total.status.items() if k != 200},
    }
    return rows


def print_report(title: str, rows: dict) -> None:
    print(f'\n== {title}')
    head = f'{"endpoint":<16}{"reqs":>8}{"fail":>7}{"rps":>9}{"p50":>8}{"p90":>8}{"p95":>8}{"p99":>8}{"max":>9}  非 200'
    print(head)
    print('-' * len(head))
    for name in [*sorted(k for k in rows if k != '__total__'), '__total__']:
        r = rows[name]
        label = 'TOTAL' if name == '__total__' else name
        extra = ' '.join(f'{k}×{v}' for k, v in r['status'].items())
        if r['biz_fail']:
            extra += f' biz×{r["biz_fail"]}'
        print(
            f'{label:<16}{r["requests"]:>8}{r["fail"]:>7}{r["rps"]:>9}'
            f'{r["p50"]:>8}{r["p90"]:>8}{r["p95"]:>8}{r["p99"]:>8}{r["max"]:>9}  {extra}'
        )
    t = rows['__total__']
    if t['status'].get('429'):
        print('\n⚠️ 出现 429：测到的是限流器，不是服务能力。降低并发，或在测试环境把 REQUEST_LIMITER_ENABLED 关掉（prod 不允许）。')
    if t['status'].get('401'):
        print('\n⚠️ 出现 401：token 过期或被踢（同账号会话数有上限）。缩短 -d，或换一个专用压测账号。')
    if t['requests'] and t['fail'] / t['requests'] > 0.01:
        print(f'\n🔴 失败率 {t["fail"] / t["requests"]:.1%}，这一档的延迟数字只算成功请求，不要单看它下结论。')


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--base-url', default=os.environ.get('LT_BASE_URL', 'http://127.0.0.1:8088/api/v1'),
                   help='接口前缀，直连 uvicorn 是 :8088/api/v1，经 web 的 nginx 是 :8080/api/v1')
    p.add_argument('--username', default=os.environ.get('LT_USER', 'admin'))
    p.add_argument('--password', default=os.environ.get('LT_PASSWORD', '123456'))
    p.add_argument('--token', default=os.environ.get('LT_TOKEN'), help='已有的 access_token，给了就不登录')
    p.add_argument('--redis-container', default=os.environ.get('LT_REDIS_CONTAINER'),
                   help='验证码开着时，从这个容器的 Redis 读答案（本地一般是 fba_redis）')
    p.add_argument('--redis-db', type=int, default=int(os.environ.get('LT_REDIS_DB', '0')),
                   help='后端用的 REDIS_DATABASE 库号，读验证码答案时要对上，默认 0')
    p.add_argument('--captcha-prefix', default='fba:login:captcha')
    p.add_argument('-c', '--concurrency', type=int, default=20, help='并发数（每个并发是一个循环，发完一个再发下一个）')
    p.add_argument('-d', '--duration', type=float, default=30, help='每一档跑多少秒')
    p.add_argument('--stages', help='阶梯加压，逗号分隔的并发数，例如 10,25,50,100；给了就忽略 -c')
    p.add_argument('--warmup', type=float, default=3, help='正式计数前先热身几秒（不计入报告）')
    p.add_argument('--think', type=float, default=0, help='每次请求后停几秒，模拟真人；默认 0 = 满速')
    p.add_argument('--timeout', type=float, default=10, help='单个请求的超时秒数')
    p.add_argument('--only', help='只压这几个接口，逗号分隔的名字，如 user.list,menu.sidebar')
    p.add_argument('--json', dest='json_out', help='把结果另存为 JSON')
    p.add_argument('--allow-remote', action='store_true', help='允许压非本机地址（先确认那是你的测试环境）')
    # pnpm 11 会把 `--` 原样传进来（`pnpm loadtest -- -c 5`），argparse 不认，这里吞掉
    argv = [a for i, a in enumerate(sys.argv[1:]) if not (i == 0 and a == '--')]
    return p.parse_args(argv)


async def main() -> None:
    args = parse_args()
    host = urlparse(args.base_url).hostname or ''
    if host not in LOCAL_HOSTS and not args.allow_remote:
        sys.exit(f'{host} 不是本机地址。确认这是测试环境后加 --allow-remote；生产环境不要压。')

    endpoints = ENDPOINTS
    if args.only:
        wanted = set(args.only.split(','))
        unknown = wanted - {n for n, _, _ in ENDPOINTS}
        if unknown:
            sys.exit(f'没有这些接口：{sorted(unknown)}；可选：{[n for n, _, _ in ENDPOINTS]}')
        endpoints = [e for e in ENDPOINTS if e[0] in wanted]

    async with httpx.AsyncClient(base_url=args.base_url, timeout=args.timeout) as client:
        try:
            token = args.token or await login(client, args)
        except httpx.HTTPError as e:
            sys.exit(f'连不上 {args.base_url}：{e!r}。后端起了吗（pnpm dev）？')
    print(f'目标 {args.base_url} · 服务 {await identify(args.base_url, args.timeout)} · 接口 {len(endpoints)} 个 · token 已就绪')

    stages = [int(x) for x in args.stages.split(',')] if args.stages else [args.concurrency]
    results = {}
    for conc in stages:
        if args.warmup:
            await run_stage(args.base_url, token, conc, args.warmup, args.timeout, args.think, endpoints)
        stats, elapsed = await run_stage(args.base_url, token, conc, args.duration, args.timeout, args.think, endpoints)
        rows = summarize(stats, elapsed)
        results[str(conc)] = rows
        print_report(f'并发 {conc} · {elapsed:.0f}s', rows)

    if len(stages) > 1:
        print('\n== 阶梯汇总（延迟单位 ms）')
        print(f'{"并发":>6}{"rps":>9}{"p50":>8}{"p95":>8}{"p99":>8}{"失败率":>9}')
        for conc, rows in results.items():
            t = rows['__total__']
            rate = t['fail'] / t['requests'] if t['requests'] else 0
            print(f'{conc:>6}{t["rps"]:>9}{t["p50"]:>8}{t["p95"]:>8}{t["p99"]:>8}{rate:>9.1%}')
        print('拐点：rps 不再随并发上涨、而 p95 开始陡升的那一档。')

    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as f:
            json.dump({'base_url': args.base_url, 'stages': results}, f, ensure_ascii=False, indent=2)
        print(f'\n已写入 {args.json_out}')


if __name__ == '__main__':
    asyncio.run(main())
