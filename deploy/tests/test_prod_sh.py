"""`deploy/prod.sh` 的回归测试：python -m unittest discover -s deploy/tests -v（只需要 bash，不需要 Docker）。

守的是部署后「线上是不是刚部署的那一版」这一步（#378）。这段逻辑只在真的发版时才跑，
写反一个条件的后果是**静默**的：要么该拦的没拦，要么把回滚堵死 —— 而 CI 里没有别的东西会碰到它。

做法：把 `prod.sh` 里的几个函数原样取出来，在一个桩环境里执行（假的 `curl` / `docker` / `git`）。
不整份执行脚本：`up` 的前置检查要求 `.env.server` 属主是 uid 1000，CI 的 runner 不是。
"""

import re
import shutil
import subprocess
import tempfile
import unittest

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROD_SH = REPO / 'deploy' / 'prod.sh'
BASH = shutil.which('bash')

FULL = '2b41a75c0ffee0123456789abcdef0123456789a'
OLD_STATUS = '{"status":"ok","services":{"api":{"status":"ok"}},"heartbeat_max_age_seconds":180}'
OLD_VERSION = '{"buildId":"x-1","builtAt":"2026-11-10T00:00:00.000Z"}'


def status(commit: str | None) -> str:
    value = 'null' if commit is None else f'"{commit}"'
    return OLD_STATUS[:-1] + f',"version":"1.1.2","commit":{value}}}'


def version_json(commit: str | None) -> str:
    value = 'null' if commit is None else f'"{commit}"'
    return OLD_VERSION[:-1] + f',"version":"1.1.2","commit":{value}}}'


def functions(*names: str) -> str:
    """从 prod.sh 里按名字取函数定义（顶格 `name() {` 到顶格 `}`，单行的也认）"""
    src = PROD_SH.read_text(encoding='utf-8').replace('\r\n', '\n')
    out = []
    for name in names:
        m = re.search(rf'^{name}\(\) \{{.*?^\}}$|^{name}\(\) \{{.*\}}$', src, re.MULTILINE | re.DOTALL)
        if m is None:
            raise AssertionError(f'prod.sh 里找不到函数 {name} —— 被删了或改名了')
        out.append(m.group(0))
    return '\n'.join(out)


# 桩：输出走 stdout 并带前缀，`fail` 以 1 退出；`curl` 按 URL 回不同的东西，
# `/api/health/status` 的第 N 次调用回 STATUS_N（没有就回最后一个），调用次数记在文件里
HARNESS = r"""
set -euo pipefail
fail() { printf 'FAIL: %s\n' "$1"; exit 1; }
warn() { printf 'WARN: %s\n' "$1"; }
info() { printf 'INFO: %s\n' "$*"; }
ok() { printf 'OK: %s\n' "$*"; }
sleep() { :; }
setting() { if [ "$1" = TAG ]; then printf '%s\n' "$T_TAG"; else printf '%s\n' "$2"; fi; }
dc() { echo cid123; }
docker() { if [ -n "$T_LABEL" ]; then printf '%s\n' "$T_LABEL"; else printf '<no value>\n'; fi; }
curl() {
  local url="${!#}" n
  case $url in
    */version.json) printf '%s' "$T_WEB" ;;
    */api/health/status)
      n=$(($(cat "$T_COUNT" 2>/dev/null || echo 0) + 1))
      echo "$n" >"$T_COUNT"
      local var="T_STATUS_$n"
      printf '%s' "${!var-$T_STATUS_LAST}"
      ;;
  esac
}
"""


@unittest.skipUnless(BASH, '没有 bash')
class ProdShTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def bash(self, script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        path = Path(self.tmp.name) / 'case.sh'
        path.write_text(script, encoding='utf-8', newline='\n')
        (Path(self.tmp.name) / 'count').unlink(missing_ok=True)  # 子用例之间调用次数要清零
        base = {'PATH': str(Path(BASH).parent), 'T_COUNT': (Path(self.tmp.name) / 'count').as_posix()}
        return subprocess.run(
            [BASH, path.as_posix()],
            env={**base, **env},
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=60,
            check=False,
        )

    def verify(
        self, *, body: str, web: str = '', tag: str = 'latest', label: str = FULL
    ) -> subprocess.CompletedProcess[str]:
        script = (
            HARNESS + functions('image_label', 'json_str', 'verify_deployed_commit') + '\n'
            'verify_deployed_commit http://x "$T_BODY"\n'
        )
        return self.bash(script, {'T_BODY': body, 'T_WEB': web, 'T_TAG': tag, 'T_LABEL': label, 'T_STATUS_LAST': body})

    # ── 一致：放行，并且明说核对过了 ────────────────────────────────────────

    def test_all_agree(self) -> None:
        for tag in ('latest', 'sha-2b41a75', f'sha-{FULL}'):
            with self.subTest(tag=tag):
                r = self.verify(body=status('2b41a75'), web=version_json('2b41a75'), tag=tag)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertIn('OK: 线上提交号 2b41a75', r.stdout)

    # ── 不一致：必须失败 ────────────────────────────────────────────────────

    def test_mismatches_fail_the_deploy(self) -> None:
        cases = {
            'TAG 点名的不是线上那个': {'tag': 'sha-deadbee'},
            '镜像标签和接口对不上': {'label': 'deadbeef' * 5},
            '前后端不同提交': {'web': version_json('deadbee')},
        }
        for name, override in cases.items():
            with self.subTest(name):
                args = {'body': status('2b41a75'), 'web': version_json('2b41a75'), **override}
                r = self.verify(**args)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn('FAIL:', r.stdout)
                self.assertNotIn('OK:', r.stdout)

    def test_label_without_baked_commit_fails(self) -> None:
        """镜像有 revision 标签而接口报 null = 构建时漏了 --build-arg GIT_SHA"""
        r = self.verify(body=status(None), web=version_json(None))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('commit: null', r.stdout)

    # ── 没法核对：放行，但不能说成「一致」──────────────────────────────────

    def test_rollback_to_an_image_without_the_field_is_not_blocked(self) -> None:
        """🔴 回滚到 #378 之前的镜像：接口里没有 commit 字段。拦下来等于把回滚堵死"""
        r = self.verify(body=OLD_STATUS, web=OLD_VERSION, tag='sha-0963d34')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('INFO:', r.stdout)
        self.assertNotIn('OK:', r.stdout)

    def test_locally_built_image_is_not_blocked(self) -> None:
        for commit in (None, '2b41a75'):
            with self.subTest(commit=commit):
                r = self.verify(body=status(commit), web=version_json(commit), label='')
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_old_or_broken_web_does_not_fail(self) -> None:
        for web in (OLD_VERSION, '<!doctype html><html></html>', ''):
            with self.subTest(web=web):
                r = self.verify(body=status('2b41a75'), web=web)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertIn('OK: 线上提交号 2b41a75', r.stdout)

    def test_unrecognisable_status_is_a_warning_not_a_silent_skip(self) -> None:
        """🔴 接口没给出认得出来的响应：放行，但必须是警告 —— 不能和「旧镜像」「核对过了」长得一样"""
        for body in ('', '<html>502 Bad Gateway</html>', '{"status":"unavailable"}'):
            with self.subTest(body=body):
                r = self.verify(body=body, web=version_json('2b41a75'))
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertIn('WARN:', r.stdout)
                self.assertIn('没有核对', r.stdout)
                self.assertNotIn('OK:', r.stdout)
                self.assertNotIn('INFO:', r.stdout)

    # ── 取 status：一次没取到要重试 ─────────────────────────────────────────

    def fetch(self, *bodies: str) -> tuple[str, int]:
        script = HARNESS + functions('fetch_status_body') + '\nfetch_status_body http://x\n'
        env = {f'T_STATUS_{i}': b for i, b in enumerate(bodies, 1)}
        r = self.bash(script, {**env, 'T_STATUS_LAST': bodies[-1], 'T_WEB': '', 'T_TAG': '', 'T_LABEL': ''})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = int((Path(self.tmp.name) / 'count').read_text().strip())
        return r.stdout, calls

    def test_fetch_retries_until_the_body_is_recognisable(self) -> None:
        """🔴 第一下恰好超时 / 回了 nginx 的 unavailable：重试，不能直接拿着空响应去「核对」"""
        body, calls = self.fetch('', '{"status":"unavailable"}', status('2b41a75'))
        self.assertEqual(body, status('2b41a75'))
        self.assertEqual(calls, 3)

    def test_fetch_accepts_a_degraded_or_old_body_at_once(self) -> None:
        """503 降级、旧镜像的响应都「认得出来」，不该白等"""
        for good in (status('2b41a75'), OLD_STATUS, status(None).replace('"ok"', '"degraded"', 1)):
            with self.subTest(good=good):
                body, calls = self.fetch(good)
                self.assertEqual((body, calls), (good, 1))

    def test_fetch_gives_up_after_five_tries(self) -> None:
        body, calls = self.fetch('<html></html>')
        self.assertEqual((body, calls), ('<html></html>', 5))

    # ── build 时烙哪个提交号 ────────────────────────────────────────────────

    def build_commit(self, *, head: str, porcelain: str, given: str = '') -> subprocess.CompletedProcess[str]:
        script = (
            HARNESS + 'project_dir=/repo\n'
            # 真脚本的 warn 走 stderr；这里输出要被 $(…) 接住，桩也得走 stderr，否则警告会混进提交号里
            'warn() { printf "WARN: %s\\n" "$1" >&2; }\n'
            'git() { case "$*" in *rev-parse*) printf "%s" "$T_HEAD" ;; *status*) printf "%s" "$T_DIRTY" ;; esac; }\n'
            + functions('build_commit')
            + '\nprintf "sha=[%s]\\n" "$(build_commit)"\n'
        )
        env = {'T_HEAD': head, 'T_DIRTY': porcelain, 'T_WEB': '', 'T_TAG': '', 'T_LABEL': '', 'T_STATUS_LAST': ''}
        if given:
            env['GIT_SHA'] = given
        r = self.bash(script, env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def test_build_stamps_head_only_on_a_clean_tree(self) -> None:
        self.assertIn(f'sha=[{FULL}]', self.build_commit(head=FULL, porcelain='').stdout)

    def test_build_does_not_stamp_a_dirty_tree(self) -> None:
        """🔴 工作区有改动（含未跟踪文件）：镜像内容比 HEAD 多，烙上 HEAD 等于让线上自称是另一份源码"""
        for porcelain in (' M deploy/prod.sh\n', '?? scratch.py\n'):
            with self.subTest(porcelain=porcelain):
                r = self.build_commit(head=FULL, porcelain=porcelain)
                self.assertIn('sha=[]', r.stdout)
                self.assertIn('WARN:', r.stderr, '不烙提交号要说出来，不能悄悄给个 null')

    def test_build_honours_an_explicit_sha_and_survives_no_repo(self) -> None:
        self.assertIn('sha=[abc1234]', self.build_commit(head=FULL, porcelain=' M x\n', given='abc1234').stdout)
        self.assertIn('sha=[]', self.build_commit(head='', porcelain='').stdout)

    # ── 接线：函数在，但没人调用，等于没有 ──────────────────────────────────

    def test_script_parses_and_the_check_is_wired_into_up(self) -> None:
        r = subprocess.run([BASH, '-n', PROD_SH.as_posix()], capture_output=True, text=True, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        probe = functions('probe_after_up')
        self.assertIn('fetch_status_body "$base"', probe)
        self.assertIn('verify_deployed_commit "$base" "$status_body"', probe)
        src = PROD_SH.read_text(encoding='utf-8')
        self.assertRegex(src, r'(?s)\n  up\)\n.*?probe_after_up\n.*?;;')
        self.assertRegex(src, r'(?s)\n  build\)\n\s+GIT_SHA=\$\(build_commit\)\n\s+export GIT_SHA\n')


if __name__ == '__main__':
    unittest.main()
