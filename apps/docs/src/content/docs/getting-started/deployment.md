---
title: 部署到服务器
description: 用 CI 推到 GHCR 的镜像 + Docker Compose 部署：服务器上只放三份文件，先迁移再启动，一个健康检查地址，按提交号回滚。
sidebar:
  order: 2
---

生产环境跑的是 CI 构建好的 Docker 镜像：`main` 每次全绿后，CI 把镜像推到 GitHub Container Registry（GHCR）。服务器上只需要 Docker 和三份文件：`docker-compose.prod.yml`、`prod.sh` 脚本、填好配置的 `.env.server`。`prod.sh up` 会先跑 Alembic 迁移，成功了才启动服务。

## 生产环境跑了哪些服务

`docker-compose.prod.yml` 启动 API、Celery worker、单独的 Celery beat（调度器）和 web 容器（nginx 托管前端产物并反代 API）。数据库和 Redis 用你自己的，在 `.env.server` 里指过去。

:::caution
开发环境的 worker 内嵌了 beat（`celery worker -B`）。生产不能这么跑：多副本时每个副本都会起一个 beat，同一条定时任务会被触发 N 次。生产只跑一个 beat 容器。
:::

## 新服务器第一次怎么装

不需要 clone 仓库：

```bash
mkdir -p /srv/fastapi-react-admin && cd $_
base=https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/main
curl -fsSLO $base/docker-compose.prod.yml
curl -fsSL  $base/deploy/prod.sh -o prod.sh
curl -fsSL  $base/apps/api/deploy/backend/docker-compose/.env.server.example -o .env.server

# 填掉所有 CHANGE_ME，再把文件交给容器里的用户（uid 1000）
vi .env.server
chown 1000:1000 .env.server && chmod 600 .env.server

# 本机的差异只写在这里，compose 文件保持和仓库逐字节一致
cat > .env <<'EOF'
FBA_ENV_FILE=./.env.server
FBA_WEB_PORT=8080
FBA_PULL_MIRROR=ghcr.nju.edu.cn
EOF

bash prod.sh pull && bash prod.sh up
```

`FBA_PULL_MIRROR` 是给国内服务器用的 GHCR 镜像加速，能直连 ghcr.io 就去掉这一行。

配置文件不存在、对组或其他用户可读、或者还残留 `CHANGE_ME` 时，`prod.sh` 会拒绝启动。TLS 交给前面的负载均衡、Caddy 或宝塔反代，这套编排只出一个明文 HTTP 端口。

如果连的是已有数据库，第一次部署前先备份。

## 上线前检查清单

- [ ] `.env.server` 里的 `CHANGE_ME` 全部换掉。`ENVIRONMENT='prod'` 时后端会逐项校验长度和随机性，弱值直接拒绝启动
- [ ] `TOKEN_SECRET_KEY` 用 `python -c "import secrets;print(secrets.token_urlsafe(32))"` 新生成，不要从别的环境复制
- [ ] `CORS_ALLOWED_ORIGINS` 写成你真实的访问地址；前面有 nginx 或负载均衡时配好 `TRUSTED_PROXIES`，否则限流和 IP 白名单看到的都是代理的地址
- [ ] 用到 AI 助手、对象存储、群机器人、开放平台的，配好各自的加密密钥（`AI_ENCRYPT_SECRET_KEY`、`STORAGE_ENCRYPT_SECRET_KEY`、`NOTIFICATION_ENCRYPT_SECRET_KEY`、`OPEN_SECRET_KEY`）—— 没配时保存相应配置会直接报错，不会存明文
- [ ] `NOTIFICATION_WEB_BASE_URL` 改成真实地址，否则邮件和群消息里的链接指向 `localhost:8888`
- [ ] 管理员密码是初始化时新设的强口令，没有沿用演示站的 `123456`
- [ ] 第一次部署到已有数据库前做了备份；设好定时备份
- [ ] TLS 由前面的反代或负载均衡提供，HTTP 会跳转到 HTTPS
- [ ] 外部监控探的是 `/api/health/status`，不是 `/healthz`
- [ ] 记下当前镜像标签（`sha-<提交>`），出问题时知道回滚到哪

## 怎么更新、怎么回滚

```bash
bash prod.sh status   # 服务器上跑的是哪个提交，落后 main 多少
bash prod.sh pull
bash prod.sh up
```

CI 推了新镜像**不会**自动更新服务器，部署是人明确决定的一步。每个镜像除了 `latest` 还带 `sha-<短 SHA>` 和 `sha-<完整 SHA>` 两种标签，回滚就是拉旧标签，不用等重新构建：

```bash
TAG=sha-abc1234 bash prod.sh pull
TAG=sha-abc1234 bash prod.sh up
```

## 外部监控探哪个地址

只探一个：`https://<你的域名>/api/health/status`。它列出 API、数据库、Redis、调度器（beat）和 worker 的状态，全部正常返回 **200**，任何一项异常返回 **503**。

```json
{"status":"ok","services":{"api":{"status":"ok"},"database":{"status":"ok"},"redis":{"status":"ok"},"scheduler":{"status":"ok","last_seen_seconds":12},"worker":{"status":"ok","last_seen_seconds":31}},"heartbeat_max_age_seconds":180}
```

:::caution
不要拿 `/healthz` 做外部监控。它是 nginx 自己返回的 `200`，API 和数据库全挂了照样是绿的。同理，经域名访问一个不存在的路径会落到前端的 history fallback，返回 `200` 加 `index.html`——判断时要看响应内容，不能只看状态码。
:::

## 能自己构建镜像吗

可以，用于服务器访问不了 GHCR 的情况，这时整个仓库要在那台机器上：

```bash
pnpm deploy:prod:build
pnpm deploy:prod
```

`pull` 和本地构建二选一，不要混用，否则 `up` 跑的是哪次的镜像，取决于最后碰过本地镜像缓存的是哪条命令。

## 延伸阅读

- [`deploy/README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/README.md)——所有命令。
- [`deploy/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/deploy/AGENTS.md)——这些规矩背后踩过的坑，以及为什么刻意不做自动部署。
- [桌面端与移动端](/features/clients/)——安装包由单独的发版流程构建。
