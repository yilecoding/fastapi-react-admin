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
        config.write_text(
            'server { listen 8000; location / { default_type application/json; '
            """return 200 '{"proto":"$http_x_forwarded_proto","uri":"$request_uri"}'; } }\n"""
        )
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


if __name__ == '__main__':
    unittest.main()
