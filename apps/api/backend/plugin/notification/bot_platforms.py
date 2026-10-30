"""三家群机器人的协议：地址长什么样 · 怎么签 · 消息体 · 回包怎么判（#166 二期）。

🔴 **这个模块不认识 `backend.*` / sqlalchemy / httpx**（同短信插件的 SDK 层）：
只做「输入 → 请求 / 输入 → 分类」的纯函数，发请求、读库、解密都在 `service/senders.py`。
这样签名和分类能脱离一切做逐字节的测试。

- **飞书** `https://open.feishu.cn/open-apis/bot/v2/hook/<id>`：`timestamp + "\\n" + 密钥` 当 HMAC-SHA256 的**密钥**、
  对空串签，Base64；秒级时间戳，1 小时内有效；放进请求体。100 次/分钟 · 5 次/秒。来源：官方文档原文
- **钉钉** `https://oapi.dingtalk.com/robot/send?access_token=<token>`：密钥当 HMAC-SHA256 的密钥、签
  `timestamp + "\\n" + 密钥`，Base64 再 URL 编码；**毫秒**时间戳；拼在查询串上。20 次/分钟。
  来源：官方页面是前端渲染、抓不到原文，按多处转载的官方示例代码
- **企业微信** `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>`：没有签名，`key` 就是凭据。
  20 条/分钟。来源：官方文档原文

消息一律用**纯文本类**（飞书 `post` 的 text / a 标签，钉钉、企微的 `text`），不用 markdown：标题和正文来自业务数据
（审批标题、公告标题是用户填的），走 markdown 的话填一个 `[点这里](https://钓鱼)` 就成了群里一条看着像系统发的链接。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import parse_qs, urlencode, urlsplit

Platform = Literal['feishu', 'dingtalk', 'wecom']
Verdict = Literal['sent', 'retryable', 'permanent', 'unknown']

#: 官方地址的前缀（协议 + 主机 + 路径）。私有化部署的另配 `NOTIFICATION_BOT_EXTRA_URL_PREFIXES`
OFFICIAL_URL_PREFIXES: dict[str, tuple[str, ...]] = {
    'feishu': ('https://open.feishu.cn/open-apis/bot/v2/hook/', 'https://open.larksuite.com/open-apis/bot/v2/hook/'),
    'dingtalk': ('https://oapi.dingtalk.com/robot/send',),
    'wecom': ('https://qyapi.weixin.qq.com/cgi-bin/webhook/send',),
}

#: 每个机器人的频率上限：(每分钟, 每秒)。超了平台会拒（钉钉据转载还会封一段时间），所以发之前自己数
RATE_LIMITS: dict[str, tuple[int, int | None]] = {
    'feishu': (100, 5),
    'dingtalk': (20, None),
    'wecom': (20, None),
}

#: 哪些平台支持加签（企微没有）
SIGNING: frozenset[str] = frozenset({'feishu', 'dingtalk'})

#: 正文截断。企微 text 的 content 上限 2048 **字节**（UTF-8，官方原文）；飞书请求体上限 20 KB；钉钉没查到原文，取同企微
_WECOM_TEXT_MAX_BYTES = 2048
_FEISHU_CONTENT_MAX_CHARS = 4000
_DINGTALK_CONTENT_MAX_CHARS = 2000


def matches_prefix(url: str, prefix: str) -> bool:
    """协议、主机、端口逐项比，路径按前缀比。

    不直接 `url.startswith(prefix)`：`https://open.feishu.cn@evil.com/…` 这种带 userinfo 的写法字面上不以前缀开头，
    但反过来的变体（大小写、默认端口）会让字符串比较误判。拆开比，规则只有一条：发到的那台主机必须是前缀里那台。
    """
    try:
        u, p = urlsplit(url), urlsplit(prefix)
        u_port, p_port = u.port, p.port
    except ValueError:
        return False
    if u.username is not None or u.password is not None:
        return False
    default = {'https': 443, 'http': 80}
    return (
        u.scheme == p.scheme
        and (u.hostname or '') == (p.hostname or '')
        and (u_port or default.get(u.scheme)) == (p_port or default.get(p.scheme))
        and u.path.startswith(p.path)
        and not u.fragment
    )


def url_allowed(platform: str, url: str, extra_prefixes: tuple[str, ...] = ()) -> bool:
    return any(matches_prefix(url, p) for p in (*OFFICIAL_URL_PREFIXES.get(platform, ()), *extra_prefixes))


def has_credential(platform: str, url: str) -> bool:
    """地址里得带着凭据（飞书路径最后一段 / 钉钉 access_token / 企微 key）。只填了官方前缀的，保存时就拦下来"""
    parts = urlsplit(url)
    if platform == 'feishu':
        _, sep, token = parts.path.partition('/hook/')
        return bool(sep and token.strip('/'))
    query = parse_qs(parts.query)
    return bool(query.get('access_token' if platform == 'dingtalk' else 'key', [''])[0])


def mask_url(url: str) -> str:
    """列表里辨认用：主机 + 凭据的末 4 位。凭据短于 12 位就全掩（露 4 位等于露了三分之一）"""
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    token = (query.get('access_token') or query.get('key') or [parts.path.rstrip('/').rsplit('/', 1)[-1]])[0]
    tail = token[-4:] if len(token) >= 12 else ''
    return f'{parts.hostname}/…{"*" * 6}{tail}'


# ── 签名 ─────────────────────────────────────────────────────────────────────


def feishu_sign(secret: str, timestamp: int) -> str:
    """飞书：`timestamp\\n密钥` 是 HMAC 的**密钥**，被签的是空串（官方原文，和直觉相反，别「修」成反过来）"""
    key = f'{timestamp}\n{secret}'.encode()
    return base64.b64encode(hmac.new(key, b'', hashlib.sha256).digest()).decode()


def dingtalk_sign(secret: str, timestamp_ms: int) -> str:
    """钉钉：密钥是 HMAC 的密钥，被签的是 `timestamp\\n密钥`。返回 Base64（URL 编码由 `urlencode` 做）"""
    msg = f'{timestamp_ms}\n{secret}'.encode()
    return base64.b64encode(hmac.new(secret.encode(), msg, hashlib.sha256).digest()).decode()


# ── 请求 ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class BotRequest:
    url: str
    body: bytes


def _truncate_bytes(text: str, limit: int) -> str:
    raw = text.encode()
    if len(raw) <= limit:
        return text
    # 按字节截会截在一个汉字中间：ignore 掉残缺的那半个，再留一个省略号的位置
    return raw[: limit - 3].decode(errors='ignore') + '…'


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + '…'


def _plain(title: str, content: str, link: str | None, link_label: str) -> str:
    lines = [title]
    if content and content != title:
        lines.append(content)
    if link:
        lines.append(f'{link_label}：{link}')
    return '\n'.join(lines)


def build_request(
    platform: str,
    url: str,
    *,
    secret: str | None,
    title: str,
    content: str,
    link: str | None,
    link_label: str,
    now: float,
) -> BotRequest:
    """拼出要发的那一份请求。`now` 是 Unix 秒（测试里固定它，签名就能逐字节对）"""
    payload: dict[str, Any]
    if platform == 'feishu':
        paragraphs: list[list[dict[str, str]]] = [
            [{'tag': 'text', 'text': line}] for line in _truncate(content, _FEISHU_CONTENT_MAX_CHARS).split('\n')
        ]
        if link:
            paragraphs.append([{'tag': 'a', 'text': link_label, 'href': link}])
        payload = {'msg_type': 'post', 'content': {'post': {'zh_cn': {'title': title, 'content': paragraphs}}}}
        if secret:
            ts = int(now)
            payload = {'timestamp': str(ts), 'sign': feishu_sign(secret, ts), **payload}
    elif platform == 'dingtalk':
        text = _plain(title, _truncate(content, _DINGTALK_CONTENT_MAX_CHARS), link, link_label)
        payload = {'msgtype': 'text', 'text': {'content': text}}
        if secret:
            ts = int(now * 1000)
            url = f'{url}{"&" if "?" in url else "?"}{urlencode({"timestamp": ts, "sign": dingtalk_sign(secret, ts)})}'
    elif platform == 'wecom':
        payload = {
            'msgtype': 'text',
            'text': {'content': _truncate_bytes(_plain(title, content, link, link_label), _WECOM_TEXT_MAX_BYTES)},
        }
    else:
        raise ValueError(f'不认识的群机器人平台：{platform}')
    return BotRequest(url=url, body=json.dumps(payload, ensure_ascii=False).encode())


# ── 回包 ─────────────────────────────────────────────────────────────────────

#: 业务码 → (处理, 原因)。三家的失败**多数是 HTTP 200 + 业务码**，所以先看业务码、再看状态码。
#: 飞书的码是官方原文；钉钉的 310000 / 130101 来自转载；企微的两条官方页面上没有列错误码，是常见回包
_CODES: dict[str, dict[int, tuple[Verdict, str]]] = {
    'feishu': {
        9499: ('permanent', 'bad_request'),
        11232: ('retryable', 'rate_limited'),
        19021: ('permanent', 'sign_failed'),
        19022: ('permanent', 'ip_not_allowed'),
        19024: ('permanent', 'keyword_missing'),
    },
    'dingtalk': {
        130101: ('retryable', 'rate_limited'),
        # 310000 是「安全设置没过」的总码，具体是哪一项写在 errmsg 里，见 `_dingtalk_security`
        310000: ('permanent', 'security_check'),
    },
    'wecom': {
        45009: ('retryable', 'rate_limited'),
        93000: ('permanent', 'invalid_webhook'),
    },
}


def _dingtalk_security(msg: str) -> str:
    low = msg.lower()
    if 'keyword' in low:
        return 'keyword_missing'
    if 'sign' in low or 'timestamp' in low:
        return 'sign_failed'
    if 'ip' in low or 'whitelist' in low:
        return 'ip_not_allowed'
    return 'security_check'


def classify(platform: str, status_code: int, body: bytes) -> tuple[Verdict, str | None, str | None]:
    """返回 (处理, 原因, 原文)。原文是对方回的那句话，截短后进 `last_error`"""
    text = body.decode(errors='replace')[:500]
    try:
        data = json.loads(body) if body else None
    except ValueError:
        data = None
    code: int | None = None
    msg = ''
    if isinstance(data, dict):
        raw_code = data.get('code' if platform == 'feishu' else 'errcode')
        if isinstance(raw_code, int):
            code = raw_code
            msg = str(data.get('msg' if platform == 'feishu' else 'errmsg') or '')
    if code == 0 and 200 <= status_code < 300:
        return 'sent', None, None
    if code is not None:
        verdict, reason = _CODES.get(platform, {}).get(code, ('retryable', 'platform_error'))
        if platform == 'dingtalk' and code == 310000:
            reason = _dingtalk_security(msg)
        return verdict, reason, f'{code} {msg}'.strip()
    if status_code == 429 or status_code >= 500:
        return 'retryable', 'platform_busy', f'HTTP {status_code} {text}'.strip()
    if 200 <= status_code < 300:
        # 2xx 但读不出业务码：请求已经被收下了，可能已经进了群 —— 重发就是重复，按「结果未知」
        return 'unknown', 'unreadable_response', f'HTTP {status_code} {text}'.strip()
    return 'permanent', 'http_error', f'HTTP {status_code} {text}'.strip()
