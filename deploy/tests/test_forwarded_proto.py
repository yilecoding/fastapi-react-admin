"""真实 nginx 回归测试：python -m unittest discover -s deploy/tests -v（需要 Docker）。"""

import json
import os
import re
import subprocess
import tempfile
import unittest
import uuid

from http.client import HTTPConnection
from pathlib import Path


class ForwardedProtoTest(unittest.TestCase):
    @classmethod
    def docker(cls, *args: str) -> str:
        return subprocess.check_output(['docker', *args], text=True, timeout=180).strip()

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = Path(__file__).resolve().parents[2]
        dockerfile = (cls.repo / 'apps/web/Dockerfile').read_text(encoding='utf-8')
        production_image = re.search(r'FROM (nginx:\S+)', dockerfile).group(1)
        cls.image = os.environ.get('NGINX_TEST_IMAGE', production_image)
        cls.network = f'fra-proto-{uuid.uuid4().hex[:12]}'
        cls.backend = f'{cls.network}-api'
        cls.web = f'{cls.network}-web'
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.docker('network', 'create', cls.network)
        cls.addClassCleanup(cls.docker, 'network', 'rm', cls.network)
        config = Path(cls.tmp.name) / 'backend.conf'
        # 两条 /uploads/ 照后端 uploads.py 真实下发的缓存头造（#406）：
        # 私有 S3 → 302 预签名地址 + `private, max-age=<有效期/2>`；本地存储 → 200 + `public, max-age=86400`
        config.write_text(
            'server { listen 8000; '
            'location = /uploads/presigned.png { add_header Cache-Control "private, max-age=150" always; '
            'return 302 https://s3.example.invalid/bucket/presigned.png?X-Amz-Expires=300; } '
            'location = /uploads/local.png { add_header Cache-Control "public, max-age=86400" always; '
            "default_type image/png; return 200 'png'; } "
            'location / { default_type application/json; '
            """return 200 '{"proto":"$http_x_forwarded_proto","uri":"$request_uri"}'; } }\n"""
        )
        # 带 hash 的静态产物：验证 /assets/ 的长缓存还在（不能为了 /uploads/ 把它一起拿掉）
        assets = Path(cls.tmp.name) / 'assets'
        assets.mkdir()
        (assets / 'app-abc123.js').write_text('console.log(1)\n')
        assets.chmod(0o755)
        (assets / 'app-abc123.js').chmod(0o644)
        cls.addClassCleanup(cls.docker, 'rm', '-f', cls.backend)
        cls.docker(
            'run',
            '-d',
            '--name',
            cls.backend,
            '--network',
            cls.network,
            '--network-alias',
            'api',
            '-v',
            f'{config}:/etc/nginx/conf.d/default.conf:ro',
            cls.image,
        )
        cls.addClassCleanup(cls.docker, 'rm', '-f', cls.web)
        cls.docker(
            'run',
            '-d',
            '--name',
            cls.web,
            '--network',
            cls.network,
            '-p',
            '127.0.0.1::80',
            '-v',
            f'{cls.repo / "apps/web/nginx.conf"}:/etc/nginx/conf.d/default.conf:ro',
            '-v',
            f'{assets}:/usr/share/nginx/html/assets:ro',
            cls.image,
        )
        # 前台检查配置，并等待 nginx 已经监听；不依赖容器启动时长。
        cls.docker('exec', cls.web, 'nginx', '-t')
        cls.docker(
            'exec',
            cls.web,
            'sh',
            '-c',
            'for i in 1 2 3 4 5; do wget -qO- http://127.0.0.1/healthz && exit 0; sleep 1; done; exit 1',
        )
        address = cls.docker('port', cls.web, '80/tcp')
        cls.port = int(address.rsplit(':', 1)[1])

    def test_protocol_and_uri_reach_all_proxy_routes(self) -> None:
        # 逗号列表、任意协议和未知值都不能成为后端 scheme。
        cases = [
            (None, 'http'),
            ('http', 'http'),
            ('https', 'https'),
            ('HTTPS', 'https'),
            ('', 'http'),
            ('ftp', 'http'),
            ('https, http', 'http'),
            ('http, https', 'http'),
        ]
        for path in [
            '/api/v1/auth/login?source=proxy',
            '/uploads/test.png',
            '/ws/socket.io/?EIO=4',
        ]:
            for header, expected in cases:
                with self.subTest(path=path, forwarded_proto=header):
                    headers = {} if header is None else {'X-Forwarded-Proto': header}
                    connection = HTTPConnection('127.0.0.1', self.port, timeout=10)
                    try:
                        connection.request('GET', path, headers=headers)
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(json.loads(response.read()), {'proto': expected, 'uri': path})
                    finally:
                        connection.close()

    def fetch(self, path: str) -> tuple[int, dict[str, list[str]]]:
        connection = HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            response.read()
            headers: dict[str, list[str]] = {}
            for name, value in response.getheaders():
                headers.setdefault(name.lower(), []).append(value)
            return response.status, headers
        finally:
            connection.close()

    def test_presigned_redirect_keeps_upstream_cache_headers(self) -> None:
        # #406：`expires 30d` 对 302 也生效、且是替换上游的 Cache-Control。预签名 5 分钟就过期，
        # 浏览器却把这条 302 缓存 30 天，之后沿着它去请求过期的签名地址 → S3 403 → 图裂
        status, headers = self.fetch('/uploads/presigned.png')
        self.assertEqual(status, 302)
        self.assertEqual(headers['location'], ['https://s3.example.invalid/bucket/presigned.png?X-Amz-Expires=300'])
        self.assertEqual(headers.get('cache-control'), ['private, max-age=150'])
        self.assertNotIn('expires', headers)

    def test_local_upload_keeps_upstream_one_day_cap(self) -> None:
        # 本地存储时后端给的是「最多一天」（删掉的头像别在别人浏览器里挂太久），nginx 不能把它顶成 30 天
        status, headers = self.fetch('/uploads/local.png')
        self.assertEqual(status, 200)
        self.assertEqual(headers.get('cache-control'), ['public, max-age=86400'])
        self.assertNotIn('expires', headers)

    def test_hashed_assets_still_cached_long(self) -> None:
        status, headers = self.fetch('/assets/app-abc123.js')
        self.assertEqual(status, 200)
        self.assertIn('max-age=31536000', headers.get('cache-control', []))
        self.assertIn('public, immutable', headers.get('cache-control', []))
        self.assertIn('expires', headers)


if __name__ == '__main__':
    unittest.main()
