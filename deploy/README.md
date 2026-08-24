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

```bash
pnpm deploy:prod:config  # 校验 Compose 展开结果，不启动服务
pnpm deploy:prod:build   # 构建 API 和 web 镜像
pnpm deploy:prod         # 后台启动生产服务
pnpm deploy:prod:logs    # 跟踪最近 200 行日志
pnpm deploy:prod:down    # 停止容器；不要使用 down -v
```

真实的 `DATABASE_*`、`TOKEN_SECRET_KEY`、`REDIS_PASSWORD`、域名和代理网段由部署环境注入，
不要写入 Git、镜像或 CI 日志。若必须纳入版本控制，使用 SOPS + age 等加密方案。
