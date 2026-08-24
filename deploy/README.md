# 部署命令

仓库不提交真实密钥。生产机先创建并填写被 `.gitignore` 忽略的配置文件：

```bash
cp apps/api/deploy/backend/docker-compose/.env.server.example \
  apps/api/deploy/backend/docker-compose/.env.server
chmod 600 apps/api/deploy/backend/docker-compose/.env.server
```

## 测试依赖环境

`deploy:test` 启动 SQL Server 和 Redis 依赖，应用本身仍由 `pnpm dev` 启动：

```bash
pnpm deploy:test
pnpm deploy:test:down
```

## 生产环境

生产命令会先检查配置文件存在、权限不向组/其他用户开放，并拒绝 `CHANGE_ME` 占位值。
首次部署前请备份外部 SQL Server；`up` 会先运行 Alembic migration，成功后才启动 API、worker、beat 和 web。

镜像**不在这台机器上构建**——CI 在 main 分支全部检查通过后会把 `fba-api` / `fba-web`
build 好推到 GHCR（`ghcr.io/<owner>/fba-api` / `fba-web`），日常部署只管拉：

```bash
pnpm deploy:prod:config  # 校验 Compose 展开结果，不启动服务
pnpm deploy:prod:pull    # 从 GHCR 拉 CI 已经构建好的镜像
pnpm deploy:prod         # 后台启动生产服务
pnpm deploy:prod:logs    # 跟踪最近 200 行日志
pnpm deploy:prod:down    # 停止容器；不要使用 down -v
```

回滚：镜像标签除了 `latest` 还有 `sha-<短 SHA>`，改环境变量 `TAG` 重新
`pull` + 重新启动即可，不用等一次新的构建：

```bash
TAG=sha-abc1234 pnpm deploy:prod:pull
TAG=sha-abc1234 pnpm deploy:prod
```

⚠️ 只在没有 GHCR 访问、需要离线从源码构建时才用 `pnpm deploy:prod:build`
（本地 `docker build`，不经 CI，不推镜像）——两条路二选一，不要混用，
否则 `up` 到底跑的是哪个来源的镜像取决于哪条命令最后碰过本地镜像缓存，
容易搞不清楚线上到底跑的是哪次构建。

真实的 `DATABASE_*`、`TOKEN_SECRET_KEY`、`REDIS_PASSWORD`、域名和代理网段由部署环境注入，
不要写入 Git、镜像或 CI 日志。若必须纳入版本控制，使用 SOPS + age 等加密方案。
