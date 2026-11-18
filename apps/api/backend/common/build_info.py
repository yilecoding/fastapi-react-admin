"""构建信息：线上跑的是哪个版本、哪个提交（#378）

`/health/status`（不鉴权）、工作台「服务状态」卡片、「关于」弹窗读的都是这里 —— 只有一份。

🔴 **对外只给 `version` + 7 位 `commit`。** `/health/status` 不鉴权，这里多放一个字段就是多公开一个字段：
分支名、构建时间、依赖版本都不放（Spring Boot Actuator `/info` 默认不对外暴露也是这个理由）。

提交号来自镜像构建时写进去的环境变量 `GIT_SHA`（`Dockerfile.prod` 的 `ARG GIT_SHA` → `ENV`）——
镜像里没有 `.git`，运行时读不到。本地开发没有这个变量，`commit` 是 `None`；
**不回落成 `git rev-parse`**：那会让「镜像里没带进提交号」在开发机上看不出来。
"""

import os
import re

from backend import __version__

#: 下发的提交号长度。和 GitHub 网页、镜像的 `sha-<短 SHA>` 标签、`prod.sh status` 同一个长度
COMMIT_LENGTH = 7

_SHA = re.compile(r'[0-9a-f]{7,40}')


def _short_commit(raw: str | None) -> str | None:
    """不是提交号的值一律当成没有 —— 构建参数没传时 `ARG` 是空串，也有人会传 `unknown` / `dev`"""
    sha = (raw or '').strip().lower()
    return sha[:COMMIT_LENGTH] if _SHA.fullmatch(sha) else None


def build_info() -> dict[str, str | None]:
    """每次调用现读环境变量：读一次环境变量的代价可以忽略，换来测试里能直接 `monkeypatch.setenv`"""
    return {'version': __version__, 'commit': _short_commit(os.environ.get('GIT_SHA'))}
