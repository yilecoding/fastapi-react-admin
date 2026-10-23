# 部署命令

踩坑记录在 [`deploy/AGENTS.md`](./AGENTS.md)，这一份只讲怎么敲。

## 测试依赖环境

`deploy:test` 启动 SQL Server 和 Redis 依赖，应用本身仍由 `pnpm dev` 启动：

```bash
pnpm deploy:test
pnpm deploy:test:down
```

## 生产环境

镜像**不在部署机上构建**——CI 在 main 全绿后把 `fba-api` / `fba-web` 推到 GHCR
（`ghcr.io/<owner>/…`），部署机只管拉。所有生产命令都走同一个脚本
`deploy/prod.sh`，它先检查配置文件存在、权限不向组 / 其他用户开放、没有
`CHANGE_ME` 残留，然后才调 `docker compose`。`up` 会先跑 Alembic 迁移，
成功了才启动 api / worker / beat / web。首次部署前先备份外部数据库。

### 两种拓扑，命令是同一套

脚本刻意不依赖仓库，所以两边敲的是同一个东西，只是入口不同：

|  | 开发机（有完整仓库） | 部署机（只有几份文件） |
|---|---|---|
| 装了什么 | 仓库 + pnpm + node | 只有 docker |
| 怎么调 | `pnpm deploy:prod:pull` | `bash prod.sh pull` |
| compose 在哪 | 仓库根 | 和脚本同层 |
| `.env.server` 在哪 | `apps/api/deploy/backend/docker-compose/` | 和 compose 同层（`.env` 里指） |

🔴 **`pnpm deploy:prod*` 只在开发机上有意义**——部署机上没有 pnpm，那边一律
`bash prod.sh <命令>`。别在部署机上找 `pnpm`，也别为了能跑 pnpm 去 clone 整个仓库。

```bash
pnpm deploy:prod:config   # 展开并校验 compose，不启动任何东西
pnpm deploy:prod:pull     # 从 GHCR 拉 CI 构建好的镜像
pnpm deploy:prod          # 后台启动
pnpm deploy:prod:status   # 在跑的是哪个提交、和 main 差多少
pnpm deploy:prod:logs     # 跟踪最近 200 行
pnpm deploy:prod:down     # 停止容器；不要 down -v
```

### 部署机第一次装

三份文件（外加一份 `.env`），不需要 clone 仓库：

```bash
mkdir -p /srv/fastapi-react-admin && cd $_
base=https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/main
curl -fsSLO $base/docker-compose.prod.yml
curl -fsSL  $base/deploy/prod.sh -o prod.sh
curl -fsSL  $base/apps/api/deploy/backend/docker-compose/.env.server.example -o .env.server

# 填掉 .env.server 里的 CHANGE_ME，然后把它交给容器里的 uid 1000
vi .env.server
chown 1000:1000 .env.server && chmod 600 .env.server

# 本机差异只写这里，compose 本身保持和仓库逐字节一致
cat > .env <<'EOF'
FBA_ENV_FILE=./.env.server
FBA_WEB_PORT=8080
FBA_PULL_MIRROR=ghcr.nju.edu.cn
EOF

bash prod.sh pull && bash prod.sh up
```

`.env` 里那三行的含义、以及为什么不能直接去改 compose，见
[`deploy/AGENTS.md`](./AGENTS.md)。TLS 交给上游 LB / Caddy / 宝塔反代，
这份编排只出一个明文端口。

### 日常更新

```bash
bash prod.sh status     # 先看服务器落后 main 多少
bash prod.sh pull
bash prod.sh up
```

CI 推完镜像**不会**自动同步到服务器，这一步是人明确决定的——理由见
[`deploy/AGENTS.md`](./AGENTS.md) 的「自动部署：刻意没做」。

编排文件本身有变动时（加了服务、改了健康检查……），镜像的 `pull` 带不过来，
要单独同步一次：

```bash
bash prod.sh sync       # 从 GitHub 取仓库版本，先 diff 给你看，确认后覆盖
```

### 回滚

镜像除了 `latest` 还有 `sha-<短 SHA>` 和 `sha-<完整 SHA>` 两种标签，
改 `TAG` 重新拉 + 重启即可，不用等一次新构建：

```bash
TAG=sha-abc1234 bash prod.sh pull
TAG=sha-abc1234 bash prod.sh up
```

⚠️ 2026-09-02 之前构建的镜像**只有完整 SHA 标签**，回滚到更早的版本要用完整的。

### 离线 / 不走 GHCR

只在没有 GHCR 访问、需要从源码构建时用，且要求整个仓库在这台机器上：

```bash
pnpm deploy:prod:build
pnpm deploy:prod
```

⚠️ 和 `pull` 二选一，不要混用——否则 `up` 跑的到底是哪次构建的镜像，
取决于哪条命令最后碰过本地镜像缓存。

## 外部监控探哪几条

外部监控**只探一条**：`https://<域名>/api/health/status`。一个地址列出每个服务的状态，
全部正常回 **200**，任何一项不正常回 **503**。其余几条是给编排和部署脚本用的，语义各不相同，不要混用：

| 地址 | 看什么 | 谁在用 |
|---|---|---|
| `https://<域名>/api/health/status` | api · 数据库 · Redis · 调度器（beat）· worker | **外部监控** |
| `https://<域名>/api/health/ready` | 只看数据库 + Redis | `prod.sh up` 部署后的探活（必须 200，否则判部署失败） |
| 容器内 `:8000/health/ready` | 同上 | compose 里 api 的 healthcheck（web / beat 都等它） |
| `/healthz` | 只证明 web 容器里的 nginx 活着 | web 镜像的 `HEALTHCHECK` |

🔴 **不要拿 `/healthz` 做外部监控。** 它是 nginx 自己 `return 200`，api、数据库全挂了照样绿。
同理，经域名探任何一个不存在的路径（比如已经删掉的 `/health/live`）都会落到前端的 history fallback，
回 200 + `index.html` —— **判定前先看一眼 body**。

### 返回示例

全部正常（200）：

```json
{"status":"ok","services":{"api":{"status":"ok"},"database":{"status":"ok"},"redis":{"status":"ok"},"scheduler":{"status":"ok","last_seen_seconds":12},"worker":{"status":"ok","last_seen_seconds":31}},"heartbeat_max_age_seconds":180}
```

worker 停了（503）：

```json
{"status":"degraded","services":{"api":{"status":"ok"},"database":{"status":"ok"},"redis":{"status":"ok"},"scheduler":{"status":"ok","last_seen_seconds":8},"worker":{"status":"stale","last_seen_seconds":187}},"heartbeat_max_age_seconds":180}
```

api 不在（发版换容器 / 进程停了），web 的 nginx 替它回（503，带 `X-FBA-Updating: 1` 头，**没有 `services`**）：

```json
{"status":"unavailable","msg":"系统正在更新或 api 已停止，请稍后再试"}
```

### 每一项的 status

| 值 | 含义 |
|---|---|
| `ok` | 正常 |
| `error` | 连不上，附 `"error":"<异常类型名>"`（只给类型名，不给异常信息） |
| `stale` | 心跳超过 `heartbeat_max_age_seconds`（180 秒）没更新，`last_seen_seconds` 是停了多久 |
| `missing` | 从来没写过心跳 —— 多半是「后台任务心跳」那条调度被停用或删了 |
| `unknown` | 判断不了：调度器停了（worker 收不到心跳任务，看不出它停没停），或者心跳存储（Redis）读不到 |

心跳的来路：调度器的心跳由 beat 的调度循环每 15～60 秒写一次；worker 的心跳靠「后台任务心跳」这条调度
（`health.heartbeat`，每 60 秒一次）。🔴 **在「定时任务」页停用或删掉这条调度，worker 一项就会一直报异常。**

### 给监控方的判定方法

- **用 HTTP 状态码判定：200 = 正常，其余都是异常**（503、超时、连不上）
- 🔴 **不要只匹配关键字 `"status":"ok"`** —— 降级时正常的那几项里也有这个子串，会被误判成正常。
  要用关键字的话，匹配开头的 `{"status":"ok","services"`
- 按服务分别告警：匹配 `"worker":{"status":"ok"`、`"scheduler":{"status":"ok"`、`"database":{"status":"ok"`、
  `"redis":{"status":"ok"`，哪条匹配不上就是哪个服务坏了。字段顺序和紧凑格式是固定的
- 频率与阈值：建议每分钟探一次、**连续 3 次失败才告警**，容得下一次发版。探针超时设 15 秒以上
  （每项检查各自有超时、并发执行，最慢 5 秒）

### 这一条覆盖不到的

- 域名、证书、宝塔那一层反代本身（探针走域名的话能间接覆盖到「通不通」，证书快过期不会报）
- 外部对接成不成功：邮件、对象存储、OAuth2、AI 服务商 —— 刻意不算进来，否则对方一抖这里就 503
- 磁盘、内存、CPU；worker 多副本时挂了其中一个（剩下的还在消费，心跳照常）
- 业务层面的「任务执行失败」—— 心跳只证明 worker 在消费，不证明每个任务都跑成功了，失败要看「执行记录」页

---

真实的 `DATABASE_*`、`TOKEN_SECRET_KEY`、`REDIS_PASSWORD`、域名和代理网段由部署
环境注入，不要写入 Git、镜像或 CI 日志。若必须纳入版本控制，使用 SOPS + age
等加密方案。
