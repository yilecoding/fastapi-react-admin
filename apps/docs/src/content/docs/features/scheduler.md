---
title: 定时任务
description: 在界面上管理 Celery 定时任务：cron 或固定间隔、cron 预览、启停、立即执行一次、执行记录；改动不用重启 beat；内置 11 条任务（日志清理、回收站、导出过期、通知与 Webhook 投递、审批超时、心跳）各自干什么。
sidebar:
  order: 1
---

定时任务存在数据库的 `task_scheduler` 表里，由 Celery beat 读出来按时派发、worker 执行。在「定时任务 → 任务调度」里新建、修改、启停一条任务，**不用重启 beat**：每次改动都会通知 beat 重新读表。每次执行的结果（成功 / 失败、返回值、异常栈、哪个 worker 跑的）记在「执行记录」里，保留 30 天。系统自带 11 条任务，日志清理、导出过期、通知投递、审批超时都靠它们。

## 在界面上哪里找？

| 页面 | 路径 | 权限码 | 做什么 |
|---|---|---|---|
| **定时任务 → 任务调度** | `/scheduler/manage` | 查看 `task:scheduler:list` · 新建 `add` · 修改与启停 `edit` · 立即执行 `run` · 删除 `del` | 任务列表、新建 / 编辑、cron 预览 |
| **定时任务 → 执行记录** | `/scheduler/record` | 查看 `task:result:list` | 每次执行的状态、重试次数、执行节点；点时间看返回值和异常栈 |

⚠️ 「任务调度」页的前端路由守卫认的是 `task:scheduler:edit`，不是 `list` —— 只授了查看的角色打不开这一页。「执行记录」页没有路由守卫，但它的列表接口要 `task:result:list`，没有这个码的人进得去、列表加载失败。

## 一条任务能配什么？

| 字段 | 说明 |
|---|---|
| 任务名称 | 给人看的名字 |
| Celery 任务 | **只能从下拉里选**，列出的是 worker 里已经注册了的任务（`celery.*` 内置任务除外），不能手填 |
| 调度类型 | **定时**（crontab，5 段）或 **间隔**（按秒 / 分 / 时 / 天） |
| 只运行一次 | 跑完一次就停 |
| 启用 | 停用的不会被派发 |
| 位置参数 · 关键字参数 | JSON 数组 · JSON 对象，原样传给任务函数 |
| 备注 | |

服务端要求 crontab 是 5 段、能被 Celery 解析，开始时间要早于结束时间；前端的构建器也会直接拒掉 Quartz 那种带秒和 `?` 的写法。

**cron 预览**：表单上有常用写法的快捷按钮和可视化的构建器，下面列出「接下来 5 次（服务端时区 …）」的触发时间 —— 按**服务器的时区**算，不是浏览器的，避免「我这里看着是 9 点、服务器上其实是 1 点」。

列表上每条任务有启停开关、「立即执行一次」（不管启没启用都会派发，返回 Celery 的任务 ID）和删除。指向一个 worker 里**没注册**的任务的那一行会标红 —— 这种调度 beat 照样派发、worker 收到就丢，日志里只有一句 `Received unregistered task`。

## 改了任务，什么时候生效？

立即。每次通过界面或接口改动（新建、修改、启停、删除），事务提交之后都会在 Redis 里打一个「有变更」的标记，beat 每一拍都看这个标记，看到就重新读表。另外 beat 每 5 分钟无条件重读一次，兜住绕过接口直接改库的情况。

cron 按 `DATETIME_TIMEZONE`（默认 `Asia/Shanghai`）的**墙上时间**算：写 `30 2 * * *` 就是本地时间 2:30。PostgreSQL 把时间读回来是 UTC，曾经让任务晚 8 小时触发、或者 beat 一启动就把当天的任务补跑一遍；现在读回来之后先换算成应用时区。

## 内置了哪些任务？

种子数据里的 11 条，全部默认启用：

| 名称 | 任务 | 什么时候跑 | 干什么 |
|---|---|---|---|
| 清理历史日志 | `maintenance.prune_logs` | 每天 03:15，参数 `{"days": 180}` | 删掉超过 N 天的登录、操作、开放接口、短信日志；通知投递、Webhook、数据变更记录按各自的保留天数删。见[日志与审计](/features/audit-logs/#记录保留多久) |
| 清理任务执行记录 | `maintenance.prune_task_results` | 每天 03:30，参数 `{"days": 30}` | 删掉超过 N 天的执行记录 |
| 清理回收站 | `maintenance.purge_recycled_files` | 每天 03:45 | 彻底删除回收站里超过 `FILE_RECYCLE_DAYS` 天的文件 |
| 清理过期分片 | `maintenance.purge_stale_multipart` | 每天 04:00 | 删掉过期的分片上传留下的分片 |
| 清理过期导出 | `maintenance.purge_expired_exports` | 每小时第 20 分 | 删过期的导出文件、把卡住的导出记成失败、删旧记录 |
| 每日问候 | `notification.send_daily_greeting` | 每天 09:00 | 给所有人发一条随机问候（演示用，不需要可以停掉） |
| 后台任务心跳 | `health.heartbeat` | 每 60 秒 | 写 worker 心跳，[健康检查](/features/monitoring/#健康检查接口返回什么)靠它判断 worker 活着 |
| 公告收件箱对时 | `notice.sync_inbox` | 每 60 秒 | 到点发布定时公告、撤回过期公告 |
| 通知投递 | `notification.deliver_pending` | 每 15 秒 | 发出排队中的邮件、短信、群机器人消息 |
| Webhook 投递 | `open.webhook_deliver_pending` | 每 15 秒 | 发出到期的 Webhook |
| 审批超时处理 | `workflow.handle_timeouts` | 每 5 分钟 | 按节点配置对超时的审批提醒、自动同意或自动驳回 |

后四条来自插件（公告、通知、能力开放、审批流），没装对应插件就没有。

## 生产环境要注意什么？

- **beat 只能起一个。** 起了两个，每条任务都会被派发两次。生产的 compose 给 beat 写死了 `container_name: fba_beat`，`--scale beat=2` 会直接报错，而不是悄悄起两个。worker 可以按需加。
- 开发时 `pnpm dev` 在 Linux 上用 `-B` 把 beat 嵌在 worker 里；macOS 和 Windows 上分成两个进程。`-B` 只用于开发。
- **broker 用的 Redis 库**默认是 1 号（`CELERY_BROKER_REDIS_DATABASE`）。如果这台 Redis 上还有别的项目的 Celery 也用 1 号库，两边会互相抢任务，换一个没人用的库号。
- 任务的超时由仓库自己的 `with_timeout` 控制，默认 30 分钟（`CELERY_TASK_TIME_LIMIT`）。

## 有哪些开关？

定时任务本身没有参数配置项，都在界面上一条条配。`.env` 里的，改完重启 worker 和 beat：

| 键 | 默认值 | 说明 |
|---|---|---|
| `CELERY_BROKER` | `redis` | 或 `rabbitmq`（再配 `CELERY_RABBITMQ_*`） |
| `CELERY_BROKER_REDIS_DATABASE` | `1` | broker 用的 Redis 库号，和别的项目共用 Redis 时换掉 |
| `CELERY_TASK_TIME_LIMIT` | `1800` | 单个任务最长跑多少秒 |
| `CELERY_TASK_MAX_RETRIES` | `5` | 失败重试次数 |
| `DATETIME_TIMEZONE` | `Asia/Shanghai` | cron 按这个时区的本地时间算 |

## 怎么加一个自己的定时任务？

1. 写在 `apps/api/backend/app/task/tasks/<包名>/tasks.py` 里 —— worker 只扫描这个目录。
2. 用 `@celery_app.task(name='包名.任务名')` 注册，下面再套一层 `@with_timeout()`（照 [`tasks/base.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tasks/base.py) 的写法）。
3. 每 60 秒或更频繁的任务要加 `ignore_result=True, notify=False`，否则执行记录表一天涨几千行；有测试守着。
4. 重启 worker 之后，它就出现在「Celery 任务」的下拉里，在界面上配调度即可。
5. 要随代码发一条默认调度：在种子 SQL 里加一行、再写一条数据迁移。**不要用 Celery 的 `beat_schedule`** —— 调度只有数据库这一个来源。

**删数据的任务**另有几条规矩：分批删（先取一批 ID、再按 ID 删）；过滤用的列要有索引；按业务时间删，不按写入时间；处理过的行仍可能命中过滤条件时，用键集分页。细节在 [`app/task/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/AGENTS.md)。

## 它不做什么

- 界面上不能设开始 / 结束时间、过期秒数和队列（接口支持；在界面上编辑不会把已有的值清掉）。
- 执行记录页没有删除按钮，旧记录只靠「清理任务执行记录」这条任务清掉。
- beat 卡住时调度器的心跳仍可能在写；绕过接口直接改库的调度，最多要等 5 分钟才生效。
- 任务完成的提示消息目前只有中文。

## 代码在哪

- 接口与服务：[`app/task/api/v1/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/app/task/api/v1) · [`scheduler_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/service/scheduler_service.py)
- beat 的数据库调度器：[`app/task/utils/schedulers.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/utils/schedulers.py) · Celery 应用 [`app/task/celery.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/celery.py)
- 内置任务：[`app/task/tasks/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/app/task/tasks)
- 前端：[`pages/scheduler-manage/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/scheduler-manage)（`cron-builder.tsx`、`cron-presets.ts`）· [`pages/scheduler-record/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/scheduler-record)

## 怎么测的

后端（`apps/api/backend/app/task/tests/`）：

- [`test_scheduler_timing.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_scheduler_timing.py)：停用不用重启 beat 就生效、从库里重读的 crontab 保持本地墙上时间、一条停用的调度不会饿死其他调度。
- [`test_scheduler_api.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_scheduler_api.py)：每次写操作提交后都通知 beat、库里每条调度都指向已注册的任务、高频任务既不记结果也不广播。
- [`test_scheduler.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_scheduler.py)：`beat_schedule` 保持为空、上次运行时间换算成应用时区。
- [`test_prune_logs.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_prune_logs.py)：分批删、不是一条不设上限的大语句。

浏览器端（Playwright）：[`scheduler.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/scheduler.spec.ts)，覆盖任务调度、执行记录、cron 预览、任务参数、执行记录筛选。

## 在演示站里试试

[在线演示](https://fra.wubunan.com/sign-in)（`admin` / `123456`）：打开「定时任务 → 任务调度」，点「新建」，切到「定时」，用快捷按钮选一个写法，看下面列出的接下来 5 次触发时间；不用保存。也可以对「每日问候」点「立即执行一次」，然后去「执行记录」看它的结果，顶栏铃铛会收到那条问候。演示站是共用的，别停用内置任务。
