"""E2E 用的隔离 api（:8001，读 `backend/.env.e2e`）。`pnpm --filter api e2e:server` 调它。

🔴 原来脚本是 `ENV_FILE=.env.e2e uv run … uvicorn …`：这种「行内设环境变量」的写法 Windows 上的 pnpm
（走 cmd）直接报「'ENV_FILE' is not recognized」，Playwright 的 webServer 起不来，E2E 一条都跑不了。

🔴 **这个文件必须放在 `backend` 包外面、按文件路径跑**（`python e2e_server.py`），不能是
`python -m backend.scripts.xxx`：`-m` 会先执行 `backend/__init__.py`，它在 import 期就加载了模型和
配置（`path_conf` 读 ENV_FILE），等这里设环境变量已经晚了 —— 实测那样起来的「E2E api」连的是**开发库**，
E2E 的登录日志直接写进了 `fba_admin`。

⚠️ 不读外面的 ENV_FILE：这个入口存在的意义就是**不碰开发库**。
"""

import os

os.environ['ENV_FILE'] = '.env.e2e'

import uvicorn

if __name__ == '__main__':
    uvicorn.run('backend.main:app', host='127.0.0.1', port=8001)
