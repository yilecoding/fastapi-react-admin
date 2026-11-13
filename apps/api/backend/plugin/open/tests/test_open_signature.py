"""签名协议的守卫：服务端、三份参考实现、对接文档，必须对同一组测试向量算出同一个签名。

任何一边改了一步（排序、编码、空 body 的处理…）都会在这里红 —— 否则表现是对方照文档写的代码
一律「签名不匹配」，而服务端日志里看不出是谁改了什么。
"""

import operator
import shutil
import subprocess

from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest

from backend.plugin.open.gateway import signature
from backend.plugin.open.tests.conftest import SDK_DIR, sdk, vectors

README = Path(__file__).resolve().parents[1] / 'README.md'


@pytest.mark.parametrize('case', vectors()['cases'], ids=operator.itemgetter('name'))
def test_server_matches_vectors(case: dict) -> None:
    v = vectors()
    parts = urlsplit(case['url'])
    text = signature.string_to_sign(
        method=case['method'],
        path=parts.path,
        query=signature.canonical_query(parse_qsl(parts.query, keep_blank_values=True)),
        timestamp=v['timestamp'],
        nonce=v['nonce'],
        body=case['body'].encode(),
    )
    assert text == case['string_to_sign']
    assert signature.sign(v['secret_key'], text) == case['sign']
    assert signature.verify(v['secret_key'], text, case['sign'].upper()), '十六进制大小写不该影响比对'


@pytest.mark.parametrize('case', vectors()['cases'], ids=operator.itemgetter('name'))
def test_python_sdk_matches_vectors(case: dict) -> None:
    v = vectors()
    headers = sdk.sign_headers(
        case['method'],
        case['url'],
        case['body'].encode(),
        access_key=v['access_key'],
        secret_key=v['secret_key'],
        timestamp=v['timestamp'],
        nonce=v['nonce'],
    )
    assert headers['X-Sign'] == case['sign']


@pytest.mark.skipif(shutil.which('node') is None, reason='没有 node')
def test_node_sdk_matches_vectors() -> None:
    script = (
        "import { signHeaders } from './node/fra-open-sign.mjs';"
        "import { readFileSync } from 'node:fs';"
        "const v = JSON.parse(readFileSync('test_vectors.json', 'utf8'));"
        'for (const c of v.cases) {'
        '  const h = signHeaders(c.method, c.url, c.body,'
        '    { accessKey: v.access_key, secretKey: v.secret_key, timestamp: v.timestamp, nonce: v.nonce });'
        "  if (h['X-Sign'] !== c.sign) { console.error('MISMATCH ' + c.name); process.exit(1) }"
        '}'
        "console.log('ok ' + v.cases.length)"
    )
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script], cwd=SDK_DIR, capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f'ok {len(vectors()["cases"])}'


@pytest.mark.skipif(shutil.which('javac') is None or shutil.which('java') is None, reason='没有 JDK')
def test_java_sdk_matches_vectors(tmp_path: Path) -> None:
    """#231：Java 的请求签名原来只测了 webhook 验签，`signHeaders` 自己拼的规范化 query
    （`URLEncoder` + 三次 replace）和服务端 `quote(safe='-_.~')` 是否逐字节一致，CI 里没人验证过"""
    import json as _json

    v = vectors()
    calls = '\n'.join(
        f'        check({_json.dumps(c["name"])}, {_json.dumps(c["method"])}, {_json.dumps(c["url"])}, '
        f'{_json.dumps(c["body"])}, {_json.dumps(c["sign"])});'
        for c in v['cases']
    )
    harness = f"""
import java.nio.charset.StandardCharsets;
public class SignHarness {{
    static int bad = 0;
    static void check(String name, String method, String url, String body, String expected) throws Exception {{
        String got = FraOpenSign.signHeaders(method, url, body.getBytes(StandardCharsets.UTF_8),
            {_json.dumps(v['access_key'])}, {_json.dumps(v['secret_key'])},
            {_json.dumps(str(v['timestamp']))}, {_json.dumps(v['nonce'])}).get("X-Sign");
        if (!expected.equals(got)) {{ System.err.println("MISMATCH " + name + " " + got); bad++; }}
    }}
    public static void main(String[] a) throws Exception {{
{calls}
        if (bad > 0) System.exit(1);
        System.out.println("ok {len(v['cases'])}");
    }}
}}
"""
    (tmp_path / 'SignHarness.java').write_text(harness, encoding='utf-8')
    compiled = subprocess.run(
        ['javac', '-d', str(tmp_path), str(SDK_DIR / 'java' / 'FraOpenSign.java'), str(tmp_path / 'SignHarness.java')],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert compiled.returncode == 0, compiled.stderr
    result = subprocess.run(['java', '-cp', str(tmp_path), 'SignHarness'], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f'ok {len(v["cases"])}'


def test_readme_shows_the_same_vectors() -> None:
    """对接文档里贴出来的签名必须就是测试向量算出来的那个 —— 改了算法忘了改文档会在这里红"""
    text = README.read_text(encoding='utf-8')
    v = vectors()
    assert v['secret_key'] in text
    for case in v['cases']:
        assert case['sign'] in text, f'README 里没有「{case["name"]}」的签名'


def test_canonical_query_encodes_space_as_percent20_and_sorts_after_encoding() -> None:
    assert signature.canonical_query([('q', 'a b'), ('q', 'a+b')]) == 'q=a%20b&q=a%2Bb'
    # 先编码后排序：'~' 不编码（0x7E），'中' 编码成 %E4… —— 编码后 '%' < '~'
    assert signature.canonical_query([('k', '~'), ('k', '中')]) == 'k=%E4%B8%AD&k=~'


# ── Webhook 出站签名（#167）：三份 SDK 的 verify_webhook 和服务端对同一组向量 ─────────────────────


def _webhook_headers(v: dict, signature_value: str | None = None) -> dict[str, str]:
    return {
        'Webhook-Id': v['id'],
        'Webhook-Timestamp': str(v['timestamp']),
        'Webhook-Signature': signature_value or v['signature'],
    }


def test_python_sdk_verifies_webhooks(monkeypatch: pytest.MonkeyPatch) -> None:
    v = vectors()['webhook']
    body = v['body'].encode()
    monkeypatch.setattr(sdk.time, 'time', lambda: v['timestamp'] + 10)
    assert sdk.verify_webhook(_webhook_headers(v), body, v['secret'])
    # 连续轮换可以超过两个签名，接收方不能只检查前两个。
    assert sdk.verify_webhook(_webhook_headers(v, f'v1,bm9wZQ== v1,bm9wZTI= {v["signature"]}'), body, v['secret'])
    # body 改一个字节 / 时间戳超出窗口 / 换一把密钥 —— 都要拒
    assert not sdk.verify_webhook(_webhook_headers(v), body + b' ', v['secret'])
    assert not sdk.verify_webhook(_webhook_headers(v), body, 'whsec_' + 'A' * 32)
    monkeypatch.setattr(sdk.time, 'time', lambda: v['timestamp'] + 301)
    assert not sdk.verify_webhook(_webhook_headers(v), body, v['secret'])


@pytest.mark.skipif(shutil.which('node') is None, reason='没有 node')
def test_node_sdk_verifies_webhooks() -> None:
    script = (
        "import { verifyWebhook } from './node/fra-open-sign.mjs';"
        "import { readFileSync } from 'node:fs';"
        "const w = JSON.parse(readFileSync('test_vectors.json', 'utf8')).webhook;"
        "const h = { 'Webhook-Id': w.id, 'Webhook-Timestamp': String(w.timestamp), 'Webhook-Signature': w.signature };"
        'const now = w.timestamp + 10;'
        'const ok = verifyWebhook(h, Buffer.from(w.body), w.secret, { now });'
        "const rotated = verifyWebhook({ ...h, 'Webhook-Signature': 'v1,bm9wZQ== v1,bm9wZTI= ' + w.signature },"
        'Buffer.from(w.body), w.secret, { now });'
        "const tampered = verifyWebhook(h, Buffer.from(w.body + ' '), w.secret, { now });"
        'const stale = verifyWebhook(h, Buffer.from(w.body), w.secret, { now: w.timestamp + 301 });'
        "console.log([ok, rotated, tampered, stale].join(','))"
    )
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script], cwd=SDK_DIR, capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'true,true,false,false'


@pytest.mark.skipif(shutil.which('javac') is None or shutil.which('java') is None, reason='没有 JDK')
def test_java_sdk_verifies_webhooks(tmp_path: Path) -> None:
    import json as _json

    v = vectors()['webhook']
    harness = f"""
import java.nio.charset.StandardCharsets;
import java.util.Map;
public class Harness {{
    public static void main(String[] a) throws Exception {{
        // 大小写混合：Servlet 在 HTTP/1.1 下给的就是 Webhook-Id 这种（#231）
        Map<String, String> h = Map.of("Webhook-Id", {_json.dumps(v['id'])},
            "WEBHOOK-TIMESTAMP", "{v['timestamp']}",
            "webhook-signature", "v1,bm9wZQ== v1,bm9wZTI= " + {_json.dumps(v['signature'])});
        byte[] body = {_json.dumps(v['body'])}.getBytes(StandardCharsets.UTF_8);
        byte[] tampered = ({_json.dumps(v['body'])} + " ").getBytes(StandardCharsets.UTF_8);
        long now = {v['timestamp']}L + 10;
        System.out.println(FraOpenSign.verifyWebhook(h, body, {_json.dumps(v['secret'])}, 300, now) + ","
            + FraOpenSign.verifyWebhook(h, tampered, {_json.dumps(v['secret'])}, 300, now) + ","
            + FraOpenSign.verifyWebhook(h, body, {_json.dumps(v['secret'])}, 300, now + 300));
    }}
}}
"""
    (tmp_path / 'Harness.java').write_text(harness, encoding='utf-8')
    compiled = subprocess.run(
        ['javac', '-d', str(tmp_path), str(SDK_DIR / 'java' / 'FraOpenSign.java'), str(tmp_path / 'Harness.java')],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert compiled.returncode == 0, compiled.stderr
    result = subprocess.run(['java', '-cp', str(tmp_path), 'Harness'], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'true,false,false'
