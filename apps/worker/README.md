# worker

**这个包里没有代码**，只有一个 `dev` 脚本 —— 和 `apps/api` 同一个套路
（那个也是「只有 dev 脚本、零 JS 依赖」的 workspace 成员）。

它存在的唯一理由：让 `turbo dev` 把 celery worker 当成**第三个持久任务**起起来，
TUI 里独立一个日志窗格。写进 `apps/api` 的 `dev` 脚本里（`uvicorn & celery & wait`）
也能跑，但那样两个进程的日志会挤在同一个窗格里交替刷，而 worker 的日志很密。

## 为什么是 `-B`（内嵌 beat）而不是两个进程

`celery worker -B` 把调度器跑在 worker 的一个线程里。**开发环境**这样最合适：
一个进程、一份日志、Ctrl-C 一次全停。实测内嵌 beat 照常从
`task_scheduler` 表载入调度并按时派发。

🔴 **生产不要用 `-B`。** 多副本部署时每个副本都会跑一个 beat，
同一条调度会被触发 N 次。生产要 worker 和 beat 分开部署，且 beat **只起一个**：

```bash
pnpm --filter api celery:worker     # 可以多副本
pnpm --filter api celery:beat       # 只能一个
```

## 不想让它跟着起

`pnpm dev` 会一起拉起 web + api + worker。只要前后端：

```bash
pnpm --filter web dev
pnpm --filter api dev
```

⚠️ worker 需要 Redis（broker）和数据库（结果后端 + 调度表），
两个都在 `docker-compose.dev.yml` 里，起服务前先 `docker compose ... up -d`。
