# app/task —— 定时任务（Celery）

> Celery worker / beat、调度表、执行记录。和 `app/admin` **平级的独立 app**，
> 不是插件 —— worker 是独立进程，要能脱离 FastAPI 启动，插件的动态装载服务不了它。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 结构

```
celery.py           实例 · broker · result_backend · beat_scheduler
sync_db.py          **同步**会话，只给 beat 用（beat 是同步进程）
database.py         重写的 DatabaseBackend（沿用上游）
session.py          禁止 celery 自己建表
utils/schedulers.py DatabaseScheduler —— beat 从 task_scheduler 表读调度
tasks/base.py       TaskBase：socket.io 实时提示（**不写记录**，记录由 backend 落库）
tasks/maintenance/  真任务：清理日志 · 清理执行记录
model/ crud/ service/ schema/ api/  三层，和 admin 同构
```

## 起服务

```bash
pnpm dev                        # api + web + worker / beat
pnpm --filter worker dev        # 只起 worker
```

🔴 **开发期的 worker 由 `apps/worker/dev.mjs` 起，不是一行脚本。** celery 在 Windows 上不支持 `-B`
（报「-B option does not work on Windows」直接退出）；而且 `VAR=x cmd` 这种行内设环境变量的写法，
Windows 上的 pnpm（走 cmd）根本不认。原来那一行脚本在 Windows 上 worker 窗格直接挂掉，api / web 照常跑，
定时任务和异步通知**全都静默不执行**（工作台显示「心跳停在 N 小时前」）。现在 Windows 上拆成 worker + beat
两个进程；macOS 同样拆开（原因见下），Linux 照旧 `-B`；环境变量在 node 里设。实测：本机（Windows）`pnpm --filter worker dev` 起来后
worker `ready`、beat 正常派发。

🔴 **macOS 的 `-B` 也会坏，但不是「不支持」。** worker 可以 `ready`，内嵌 beat 随后报
`+[NSCharacterSet initialize] may have been in progress in another thread when fork() was called` 并崩溃，
只剩 worker 活着、定时任务停了。Celery 的 `EmbeddedService` 默认用子进程，
不是线程；在 worker 已启动线程后 fork，子进程触发了 Objective-C 的安全检查。
修在开发入口 `apps/worker/dev.mjs`：macOS 和 Windows 分别启动 worker / beat，
继续使用 `--pool=custom` 执行异步任务。

**实测证据**（2026-11-09，macOS 26.6 / Python 3.14.5 / Celery 5.6.3）：
原来的内嵌 beat 报上述 fork 错误；拆开后 worker `ready`，beat 载入 11 条调度并派发到内存队列，
Ctrl-C 后两个进程退出码都是 0。验证用 `CELERY_BROKER_URL=memory://` 隔离了队列，
只证明启动、载入和退出正常，没有执行实际的业务任务。

🔴 **`-B`（内嵌 beat）只用于开发。** 多副本部署时每个副本都跑一个 beat，
同一条调度被触发 N 次。生产要分开，且 beat **只起一个**：

```bash
pnpm --filter api celery:worker        # 默认队列，可以多副本
pnpm --filter api celery:worker:long   # 长任务队列（#400，见文末），可以多副本，不能省
pnpm --filter api celery:beat          # 只能一个
```

⚠️ `celery-aio-pool` 不能 `-P celery_aio_pool:pool`（celery 只认固定几个 pool 名），
要 `CELERY_CUSTOM_WORKER_POOL=celery_aio_pool.pool:AsyncIOPool` + `--pool=custom`。
已封进上面那两个脚本。

## 🔴 worker 不跑 lifespan

celery worker **不执行 FastAPI 的 lifespan**（`core/registrar.py` 那段），
所以 Redis 连接和雪花节点在 worker 里都是未初始化的。业务任务只要往自己的表里
写一行就炸：`ServerError: 雪花 ID 生成失败，雪花算法未初始化`。

**它的表现会骗人**：异常在 SQLAlchemy 的 flush 里被包成 `StatementError`，而
`celery_aio_pool` 的错误处理路径遇到没有 `__traceback__` 的异常会自己崩成
`'NoneType' object has no attribute 'tb_frame'` —— 日志里最显眼的是那句
AttributeError，真因要往上翻十几行。

Redis 补在 `celery.py` 的 `worker_process_init` 里，雪花补在 `worker_ready` 里（为什么分开见下面 #369 那一节）。只补「任务代码会用到的全局单例」，
不碰 lifespan 里属于 web 进程的东西（操作日志消费者、缓存 Pub/Sub 监听器）——
那些在 worker 里跑起来只会重复消费。

### 🔴 补完要把 Redis 连接池断开 —— 否则每个 worker 进程第一个用 Redis 的任务必失败

**症状**：worker 刚起来（= 每次发版后）的第一个用到 `redis_client` 的任务报错，之后一切正常：

```
RuntimeError: Task <…> got Future <Future pending> attached to a different loop
RuntimeError: Event loop is closed
```

**根因**：`worker_process_init` 是用 `asyncio.run()` 起的**临时**循环做初始化，
`redis_client.init()` 的 ping 建了一条连接、放回池里，循环随即关闭；
任务跑在 AsyncIOPool **自己的**循环里，从池里拿到这条绑着死循环的连接就炸。
坏连接被丢掉后重建，所以第二次就好了 —— 只坏一次、只在进程刚起来时坏，很难被注意到。

**修法**：`_init()` 最后 `await redis_client.connection_pool.disconnect()`，让任务在自己的循环里重新建连接。

**实测证据**（2026-10-23，本机 worker / beat 分开起，临时库）：临时去掉那一行重启 worker，
第一拍 `health.heartbeat` 是 `raised unexpected: RuntimeError('Event loop is closed')`；改回来再重启，
第一拍 `succeeded`。单测 `test_health.py::test_worker_init_leaves_no_connection_bound_to_its_throwaway_loop`
去掉那一行就报上面两条原文。

### 🔴 雪花节点要在 AsyncIOPool 自己的循环里初始化 —— 否则 worker 启动 60 秒后拒绝一切发号（#369）

**症状**：`DATABASE_PK_MODE='snowflake'` 且没配固定的 `SNOWFLAKE_DATACENTER_ID` / `SNOWFLAKE_WORKER_ID`
（两份 `.env.*.example` 都是这个组合）时，worker 起来 `SNOWFLAKE_NODE_TTL_SECONDS`（默认 60）秒之后，
凡是插雪花主键行的任务全挂。修之前报的是 `雪花 ID 生成失败，雪花算法未初始化`，会把人带去查启动流程。
最糟的是 Webhook：POST 已经发出去，投递记录写不进去 → 行停在 sending → 被回收、**再发一遍**。

**根因**：原来在 `worker_process_init` 的 `asyncio.run` 临时循环里 `snowflake.init()`，里面 `create_task` 起的续租心跳
随循环一起被取消。#333 之前后果只是节点 key 过期、节点号可能重复；#333 加了本地租约期限（只有心跳能往后推），
心跳不跑，期限就停在启动后 60 秒，之后 `generate()` 一律拒绝。

**修法**：雪花挪到 `celery.py: init_worker_snowflake`，挂 `worker_ready`，用 `run_coroutine_threadsafe` 投到
`sender.pool.loop`（AsyncIOPool 在独立线程里 `run_forever()` 的那个循环）上执行、`.result()` 等它完成。
❌ 不能挂 `worker_process_init`：那个信号是 `AsyncIOPool.__init__` 自己发的，发的时候 `self.loop` 还没建。
`worker_ready` 在 consumer 开始处理消息之前同步发出，主线程等着初始化做完，不会有任务抢在前面跑。
找不到 pool 的循环时只记 ERROR，**不退回 `asyncio.run`**（那正是这个 bug 的起法）。
顺带两处：租约失效改报 `error.snowflake.lease_lost`，和「未初始化」分开；单次心跳抛异常不再当场判死
（Redis 里的 key 还剩大半个 TTL），改成 2 秒后重试，只按本地期限判失效。

**实测证据**（2026-11-18，本机真 worker：`--pool=custom` + 一次性 Redis 容器，`SNOWFLAKE_NODE_TTL_SECONDS=6`、
心跳 2 秒；加了一个临时任务调 `snowflake.generate()`）：

| | 结果 |
|---|---|
| 修之前（main） | 启动后 15 秒发号：`ServerError('雪花 ID 生成失败，雪花算法未初始化')` |
| 修之后 | 心跳每 2 秒续一次，节点 key 的 TTL 在 4～6 之间来回；启动后 26 秒发号成功 `2234334186804609024` |

单测在 `backend/tests/test_snowflake_node_lease.py`：`test_worker_startup_keeps_issuing_ids_past_the_lease_ttl`（仿 AsyncIOPool 的线程循环，
1 秒租约，等 1.6 秒后仍能发号）把投递改回 `asyncio.run(snowflake.init())` 就红；
`test_one_failed_heartbeat_does_not_stop_the_generator` 把心跳异常分支改回 `_lease_valid = False` 就红。

## 🔴 `task_result` / `task_set_result` 不用雪花主键

全仓唯一的例外。理由不是省事：让「记录一次失败」依赖雪花初始化成功，
等于雪花一挂连失败都记不下来。它们是 celery 的管道，真正的键是 `task_id`（uuid）。

## SQL Server 的三笔账（上游没有）

照上游 `backend/app/task/` 的形状做，但它只支持 mysql / postgresql，
`plugin.toml` 里 `database = ['mysql', 'postgresql']` 写得很直白。改了三处：

| 上游 | 在 SQL Server 上 | 这里 |
|---|---|---|
| `traceback = sa.Text` | mssql 方言下是 **VARCHAR(max)**，中文栈变问号 | `UniversalText` |
| `task_id unique` 且可空 | SQL Server 认为多个 NULL **相等**，第二条就撞 | 筛选唯一索引 |
| `Integer + Sequence + autoincrement` | Sequence 和 IDENTITY 打架 | 纯 IDENTITY |

另外 `result_backend` 上游只拼了 postgresql / mysql，加了 mssql 一支。
走 `mssql+pyodbc`（**同步**驱动）—— celery 的 DatabaseBackend 和 beat 的
DatabaseScheduler 都是同步代码，`aioodbc` 喂不进去。
`pyodbc` 不是新依赖，它本来就是 `aioodbc` 的依赖。

## 🔴 `find_task_packages()` 在生产镜像里会把 worker/beat 直接搞崩——跟数据库无关

`celery.py: find_task_packages()` 原来用 `root.replace(str(BASE_PATH.parent) + os.path.sep, '')`
剥路径前缀——这是**全局字符串替换**，不是"剥前缀"。`Dockerfile.prod` 的
`WORKDIR /app`，业务代码自己又有一层目录也叫 `app`（`backend/app/task/...`），
于是 `/app/backend/app/task/tasks/maintenance` 这条路径里 `/app/` 这个子串
出现了**两次**：一次是开头要剥的前缀，另一次恰好是 `backend/app/task` 中间
那段。全局替换把两处都吃掉，`backend` 和 `task` 中间的点被吞掉，
autodiscover 拿到的包名是 `backendtask.tasks.maintenance`，worker/beat
启动时 `ModuleNotFoundError: No module named 'backendtask'`，进程崩溃后
被 `restart: unless-stopped` 拉起来再崩，无限重启。

**本机 `pnpm dev` 和 CI 的 pytest 都摸不到这条路径**——两边跑的都是源码直连
（`uvicorn`/`pytest` 直接 import，`BASE_PATH.parent` 是仓库里的真实路径，
不叫 `app`），只有真的拿 `Dockerfile.prod` 构建出镜像、在容器里跑
`celery -A backend.app.task.celery worker` 才会撞上这个巧合的同名碰撞。
第一次是在生产环境实测踩到的：`docker logs` 除了那句 `ModuleNotFoundError`
什么线索都没有，容器 `Up 2 seconds` 后立刻变 `Restarting`。

修法：改用 `Path(root).relative_to(BASE_PATH.parent)` 做纯路径运算再
`'.'.join(parts)`，不会误伤路径中间恰好同名的子串。验证：
`docker run --rm <api镜像> python -c "from backend.app.task.celery import find_task_packages; print(find_task_packages())"`
应该打印 `['backend.app.task.tasks.maintenance']`（点分完整，不是
`backendtask...`）。

## 两处被突变体量出来的测试缺口

拿突变体扫了一遍这个模块（当时 80 条测试），两条：

**1. 「分批删日志」这件事本身没测。** 把 `prune_logs` 里整个 while 循环换成
一条无界 `DELETE ... WHERE time_col < cutoff`，**80 条一条都不红** ——
包括名字叫 `test_batches_until_drained` 的那条，因为它验的是「删干净」，
而一条 DELETE 也能删干净。要防的后果（SQL Server 约 5000 行锁就升级成表锁 →
清理期间整站写操作日志被阻塞）在测试里造不出来，但**「发了几条 DELETE」造得出来**：
挂个 `before_cursor_execute` 监听，5 条数据 + batch=2 应该看到 ≥3 条 DELETE。

**2. 「改了调度不用重启 beat」没测。** 把 `schedule` property 里那个
`if latest is not None and latest != self._last_seen_update` 改成 `if False`
（永不重载），同样一条都不红。已有那条 `一次性抗重载` 虽然走了重载路径，
但它的断言在「重载没发生」时同样成立（内存里那个 entry 的计数也是 1）——
它测的是落库，不是重载。

失败方式完全静默：管理员在界面上改了 cron 或停用了任务，beat 一直按老的跑，
**而界面显示的是新值**，所以人只会怀疑自己的 cron 写错了。

补的那条按「先断言没有、再断言有」写，中间还钉住了标记的作用（没打标记
就不该重载，否则 beat 每 tick 都要重读整表）。双向验证过：改成永不重载 →
最后一句红；改成每次都重载 → 中间那句红。

⚠️ 那条只测了 beat 这一侧（标记变了会不会重载），**写入侧从来没打过标记** —— 页面上的改 / 启停 / 删
一直要重启 beat 才生效，见 [`utils` 分册](utils/AGENTS.md)（#183）。

> ⚠️ 数这个模块的测试条数别用 `grep -c '^def test_'` ——
> `test_scheduler_timing.py` 里有个 **fixture** 叫 `test_factory`，
> 名字以 `test_` 开头但不会被收集，grep 会多算一条。

## 调度只有一个来源：`task_scheduler` 表

🔴 **刻意不配 `beat_schedule`。** `DatabaseScheduler.setup_schedule()` 只 SELECT
那张表，**从不合并** `app.conf.beat_schedule`。曾经两边都配着、注释还写
「静态项仍然生效」—— 实测是**死代码**：celery.conf 里躺着一条谁也不会执行的调度。

新库的初始调度走**种子 SQL**（和菜单同一个路子）。这样「在界面上删掉一条调度」
不会被代码里的副本复活。`test_beat_schedule_config_is_empty` 挡住回退。

推论：celery 自带的 `celery.backend_cleanup` 由 `install_default_entries()` 装上，
而我们重写掉了那一步 —— **它不会自己出现**，执行记录的清理必须自己排
（`maintenance.prune_task_results`，种子里有）。

## 🔴 调度指向未注册的任务，是完全不可见的失败

创建时 service 层校验任务名，但那只挡住「打错字」—— **任务名住在代码里**，
改个名或删掉一个任务，库里已有的调度就指向了空，而没有任何一次写操作会经过校验。

之后：beat 照常派发 →「累计触发」照涨 → worker 收到不认识的名字只记一条
`Received unregistered task`，**不产生执行记录**。界面上看着在正常运行，
执行记录里一条都没有 —— 而没人会去比对这两个数。

三处堵着：界面标红（主要）· beat 载入时 `log.error` · CI 一条守卫
（`test_every_schedule_in_db_points_at_a_registered_task`，同时守住种子 SQL 里的拼写）。

## 🔴 `__next__` 里的触发计数必须立刻落库

`is_due()` 里 one_off 的判断读 `total_run_count`，而 `schedule` 属性一检测到
变更标记就**重载**，把计数清回库里的值。于是一次性任务触发之后、`sync()` 回写之前，
只要有人改了**任何一条**调度（增删改都会打变更标记 → 触发重载），它就会再跑一次。

用 core update 而不是 ORM update：core 不触发 `after_update` 事件，
否则这次写入自己又会打一次变更标记，变成「触发一次就重载一次」。

## 写删除类任务的纪律

`tasks/maintenance/` 里三个任务都会删数据，而且自动跑（第三个是 `purge_recycled_files`：回收站到期清除，
见 [file 分册](../../../../../packages/platform/src/pages/file/AGENTS.md)「回收站」）。三条：

- **必须分批。** 日志表是全库长得最快的表。SQL Server 单表累计约 5000 个行锁就
  **升级成表锁**，于是清理期间所有写操作日志的请求都被阻塞 —— 而每个 API 请求
  都写操作日志。表现是「凌晨三点整站卡住几分钟」，日志里只有一条任务成功
- **删的那一列必须有索引**，否则全表扫。改了模型还要在库上真建出来 ——
  没有 alembic，这两步靠人对账，`test_fresh_install_has_every_index_the_models_declare`
  是唯一的自动对账
- **按业务时间删，不是 `created_time`。** 操作日志是后台消费者批量落库的，
  两者会错开；而界面上的筛选/排序/显示全用业务时间，不一致就对不上账

分批用「先查 id 再按 id 删」，不用 `DELETE TOP (n)` —— 后者是 T-SQL 方言，
本仓库还要跑 MySQL / PostgreSQL。

🔴 **「处理完这一行它就不再匹配」不成立的任务，要按 `id > 上一批最后一个` 往后翻（keyset）。**
`prune_logs` 删掉的行不会再被选中，从头取没问题；`purge_recycled_files` 是「标记 + 删对象」，
只要有一行标不上（变异检验里让条件不看 `purged_time`），每批从头取都会把它拿回来 —— 死循环，挂到超时。

## 测试

```bash
pnpm test                       # 含本模块，见 pyproject 的 testpaths
```

⚠️ **新增 app 要往 `pyproject.toml` 的 `testpaths` 里加一行**，否则那个模块的
测试**不会被收集**，而 `pnpm test` 照样全绿。实测踩过。

写这个模块的测试踩过的（都在对应文件的注释里）：

- **控制时间，不要等待时间。** 用 1 秒间隔 + `sleep(1.2)` 的版本三跑一红 ——
  SQL Server 建引擎偶尔超过 1 秒。改成显式写 `last_run_time`，零 sleep
- **收窄断言，不要扩大清理。** beat 读的是整张表，别的用例的行会串进来。
  曾经改成「清整张表」，结果**把种子调度也删了**，让另一条守卫变成空跑通过
- **每次起独立的异步引擎。** 复用全局 `async_test_engine` 时，接口测试
  （TestClient）先跑会把连接池绑在它自己的事件循环上，
  `asyncio.run` 再开一个就 `got Future attached to a different loop`。
  **单跑那个文件不会撞到，只有全量跑才会**
- **任务里的 `async_db_session` 连的是开发库。** 不换会话，测试就是在 `fba` 上跑；
  更要紧的是反过来 —— 它真的会去删你的开发库

## 🔴 Redis 和别的项目共用时，broker 要换一个没人用的库

**症状**：worker 日志里刷 `Received unregistered task of type 'visitor.submit_eip'` ——
一个本仓库根本没有的任务名；同时本仓库的任务时有时无地丢。

**根因**：broker 默认是 Redis 的 `CELERY_BROKER_REDIS_DATABASE=1`（`core/conf.py`）。本机另一个项目的
celery 也用 6380 上的 db 1，两边的 worker 消费的是**同一个队列**：对方的任务被这边收走（报未注册），
这边的任务也会被对方的 worker 收走（**静默丢失**，这边日志里什么都没有）。

**修法**：本地 `.env` 里把 `CELERY_BROKER_REDIS_DATABASE` 指到一个空库（本机用的是 `7`），改完重启 worker。
先 `redis-cli -n <db> DBSIZE` 确认那个库是空的。生产的 Redis 是独占的，不受影响。

## 调度器 / worker 心跳 → `/health/status`（#147）

worker / beat 挂了网页照常能开、`/health/ready` 照常 200，只有定时清理、导出、通知、审批超时悄悄停 ——
外部原来完全看不到。现在两个心跳各写各的 Redis 键（epoch 秒），`core/registrar.py` 的 `/health/status` 读它们，
距今 ≤ 180 秒（`HEARTBEAT_MAX_AGE_SECONDS`）才算 ok：

| | 谁写 | 多久一次 |
|---|---|---|
| scheduler | `utils/schedulers.py: DatabaseScheduler.tick` → `write_heartbeat` | 每拍，节流到 15 秒；没有调度到期时 tick 也最多 60 秒一拍（`max_interval`） |
| worker | `tasks/health/tasks.py` 的 `health.heartbeat` | beat 每 60 秒派一次（`task_scheduler` 一行，种子 + 迁移 `u0000000health`） |
| worker_long | 消费长任务队列的 worker 自己（`celery.py: start_long_queue_heartbeat`，#400） | 每 30 秒，挂在 worker 的事件循环上，不靠 beat |

🔴 **调度器的心跳必须写在调度循环里，不能也靠派任务**：派出去的任务要 worker 执行才落得了地，
那样 beat 停了和 worker 停了看到的是同一个结果。反过来，beat 不在时 worker 收不到心跳任务，
所以接口把这种情况下的 worker 报成 `unknown`，不报 `stale`。写调度器心跳失败只记日志 ——
不能为了心跳让 beat 停摆。

高频任务的两条纪律（每分钟一次就会显形）：

| 不做会怎样 | 怎么挡 |
|---|---|
| 每次往 `task_result` 写一行 —— 一天 1440 行，「执行记录」页被淹没 | 装饰器上 `ignore_result=True` |
| `TaskBase` 的开始 / 成功提示每次都要查一遍谁能看执行记录、按人推（#400 之前是广播给**所有**在线页面） | 装饰器上 `notify=False`（`tasks/base.py` 认这个类属性；失败照推，同一任务 60 秒内一次） |

🔴 **这两条现在有守卫**：`tests/test_scheduler_api.py::test_high_frequency_tasks_neither_record_nor_broadcast`
—— 库里每条启用的、间隔 ≤ 60 秒的调度，任务上都得有这两项。补它是因为 #166 的 `notification.deliver_pending`
（每 15 秒）两项都没关就合进了 main：一天 5760 行执行记录，每 15 秒给所有在线页面推两条提示，CI 全绿。
#167 加 `open.webhook_deliver_pending` 时才发现。变异：去掉通知任务上的两项 → 这条红。
⚠️ 拿注册表要先 `celery_app.loader.import_default_modules()`：autodiscover 是惰性的，不导入就是 `NotRegistered`。

调度那一行的 `expire_seconds = 180`（= 阈值）：worker 停了很久再起来时，排队超过阈值的心跳直接丢掉。

响应末尾还有 `version` / `commit`（#378，`common/build_info.py`）：只是顺带报出来，**不参与 200 / 503 判定**，
提交号没带进镜像时是 `null`。🔴 字段顺序是契约（监控方按 `{"status":"ok","services"` 字面量匹配），
再加字段也只能**追加在最后**；`test_health.py` 的 `_services()` 按顺序断言全部键。来龙去脉见
[`deploy` 分册](../../../../../deploy/AGENTS.md)「线上是哪一版」。

**实测证据**（2026-10-23，本机：临时库 + 空闲 Redis 库号，api / worker / beat 分开起，经 `nginx:1.27-alpine` 挂真实
`apps/web/nginx.conf` 探 `/api/health/status`）：

| 演练 | 结果 |
|---|---|
| 冷启动 | 65.8 秒到 200（beat 第一次派心跳要等一个 60 秒周期；在那之前 worker 报 `missing`） |
| 停 worker | 181.0 秒后 503，`worker: stale`、`scheduler: ok` → 重启 3.2 秒恢复 200 |
| 停 beat | 140.9 秒后 503，`scheduler: stale`、`worker: unknown`（停之前最后一拍已是 43 秒前）→ 重启 2.2 秒恢复 |
| 停 api | 经 nginx 立刻 503 + `X-FBA-Updating: 1` → 重启 3.3 秒恢复 |
| 收尾 | 三个进程的日志 0 行 ERROR；心跳执行 6 次，`task_result` 里 0 行是它的，同期 `workflow.handle_timeouts` 照常写了 1 行（对照） |

⚠️ 调度器的 `last_seen_seconds` 在 beat 空闲时会涨到 60 左右再归零 —— tick 最多 60 秒一拍，节流 15 秒只在
tick 更密时起作用。所以「停 beat 到报警」是 120～180 秒，不是固定 180 秒。

🔴 **心跳不能并进 `/health/ready`**：api 容器的 healthcheck 用 ready，并进去 worker 一挂 api 也被判不健康，
web / beat 又 `depends_on` api 健康 —— 一处故障连成一串。

守卫在 `app/admin/tests/security/test_health.py`（24 条），做过 12 处变异验证（每处改坏都有对应的一条变红）：
init 不断开连接池 · 调度器停了 worker 照报 stale · 心跳任务存结果 / 推送 · notify 开关对所有任务都关 ·
三项检查串行 · worker 心跳写错键 · tick 不写心跳 · 写心跳失败往外抛 · 响应里带异常 message ·
心跳并进 ready · 阈值失效。

## 页面上停用 / 改 / 删不生效、一条调度把 beat 堵死（#183）

整节挪到了 [`utils` 分册](utils/AGENTS.md)（调度器 `utils/schedulers.py` 那一层）：写入侧不打变更标记、
堆顶堵死、定时重读的四个坑、下次触发从哪一刻算起、PostgreSQL 下 crontab 按 UTC 算。**动 `schedulers.py` 之前先读那一份。**

## 🔴 Redis 密码带 `/`：网站正常，后台任务和实时推送连不上（上游 #1276 同类）

**症状**：登录、页面都正常，`/api/health/ready` 也是 200；但 worker 起不来或一直连不上 broker，
站内消息不实时推送。`/api/health/status` 里 worker 心跳是停的。

**根因**：只认 URL 的两处（celery 的 broker、socket.io 的 `AsyncRedisManager`）拼地址时用了裸 `urllib.parse.quote(密码)`。
`quote` 默认 `safe='/'`，密码里的 `/` 原样留在 URL 里，解析器把它当成路径开头，主机、端口全错。
主站的 `redis_client` 是按参数分开传的、不走 URL，所以**只坏一半**，看着像 worker 自己的问题。
`openssl rand -base64` 生成的密码经常带 `/`。结果后端用的是 `quote_plus`，密码里的空格会变成 `+`。

**修法**：两处都走 `database/redis.py: get_redis_url()`，用户名 / 密码一律 `quote(..., safe='')`（`celery.py: _userinfo`）。

**实测证据**：密码 `Ab3/x+Yz@9`，改之前 kombu 和 redis-py 都报
`ValueError: Port could not be cast to integer value as 'Ab3'`；密码 `pass word` 经 `quote_plus` 后，
SQLAlchemy 解析回来是 `pass+word`。修后 `backend/tests/test_connection_urls.py` 用 kombu `Connection` /
redis-py `parse_url` / SQLAlchemy `make_url` 把四种密码（含 `/`、空格、`%`、中文）解析回原样，三种库都测；
把修法退回旧写法，其中 6 条变红。

## 🔴 登录 / 操作日志默认只留 30 天，低于网络安全法的六个月（#261）

**症状**：没有任何报错。用默认配置部署，五个月前的登录日志、操作日志查不到了 ——
而《网络安全法》（2016 年版）第二十一条第（三）项要求网络日志「留存不少于六个月」。部署的人不会知道要去改。

**根因**：天数写在种子调度「清理历史日志」的参数里（`{"days": 30}`），任务函数的默认值也是 30；
参数配置页看不到，部署文档也没写。开放接口调用日志、短信发送日志跟着同一个天数。

**修法**：180 写在四处，`test_prune_logs.py::test_default_retention_agrees_everywhere_and_meets_the_six_month_floor` 对账：
`tasks/maintenance/tasks.py: LOG_RETENTION_DAYS`（`days` 的默认值）· 三份种子 · 迁移 `ap000000logretention`。
迁移只改种子那一行、且参数解析出来还是 `{"days": 30}` 的；管理员调过的（哪怕比 180 短）不动，降级也不改回去。

⚠️ **没做的**：天数仍在调度参数里，没挪进参数配置（数据变更记录那个在）；登录 / 操作日志页的「删除」「清空」
仍然能删保留期内的记录。

**实测证据**（2026-11-10，PostgreSQL 私有库）：把种子那一行改回 `{"days": 30}` 和原备注，stamp 到 `ao000000loginevent`
再 `alembic upgrade head` → `{"days": 180}`、备注换成新的；参数是 `{"days": 90}` 的同样升级后原样。
三处变异各让迁移那条测试变红：按字符串比（界面上存过一次、写成 `{"days":30}` 的就漏改）· 不看备注是不是种子原文 · 不看天数。
任务默认值、一份种子退回 30，对账那条红。
存储：本机开发库操作日志 3674 条、8256 kB（含索引），平均每条约 2 KB —— 每天 1 万条留 180 天约 4 GB，写进了文档站「上线前检查清单」。

## 🔴 一个 worker 进程一次只跑一个任务：长任务单独排队（#400）

**症状**：一次 AI 预审（`with_timeout(300)`）/ 一份大导出 / 首次 `prune_logs` 期间，`/health/status` 报 `worker: stale`（503），
邮件、短信、Webhook 投递一起停在那儿；worker 进程好好的，`--concurrency` 调多大都没用。

**根因**：`celery_aio_pool.AsyncIOPool` 继承的是 solo 池，`__init__` 里写死 `self.limit = 1`；`run()` 用
`run_coroutine_threadsafe` 把协程投进循环之后**马上 `result.exception()` 同步等它跑完**，才回去取下一条消息。
「异步」只是任务函数能 `await`，消费仍是串行的。长任务和每分钟一次的 `health.heartbeat` 挤在一条队列上，心跳就排在后面。

**修法**：按任务名分两条队列（`celery.py: LONG_TASKS` → `task_routes`），两个 worker 各消费一条：
`worker -Q celery` 跑心跳 / 投递 / 审批超时，`worker -Q long` 跑导出 / AI 预审 / `maintenance.*`。
生产是 compose 里的 `worker` / `worker-long`，开发是 `apps/worker/dev.mjs` 起的两个进程（`-n default@%h` / `long@%h`）。

- 路由按**名字**配，不写在 `@task(queue=...)` 上：`send_task('export.run')`、beat、「立即执行」都只拿得到名字。
  调度那一行的 `queue` 是 `None` 时不会盖掉路由表（celery 的 `lpmerge` 跳过 None），显式填了就以它为准
- 🔴 **新任务要归类**：`tests/test_task_queues.py::test_every_registered_task_is_classified` 要求每个注册的任务都写进
  测试里的 `LONG` 或 `SHORT`，漏了就红 —— 不归类就是悄悄落进默认队列，和心跳抢 worker
- 🔴 **长任务 worker 没起 = 导出 / AI 预审 / 日志清理静默地永远不执行**（消息堆在 `long` 队列里，没人报错）。
  所以它自己写心跳（`worker_long`，`/health/status` 第六项，没起就是 `missing` → 503）。
  ❌ 不能也靠 beat 往 `long` 队列派心跳任务：那个任务排在长任务后面，一次 300 秒的预审就把「忙」报成「死」。
  心跳挂在 worker 自己的循环上、和任务交替跑（任务都是 `async def`）；只有消费 `long` 的 worker 才写，
  默认 worker 写了的话没人消费长任务时照样全绿。写失败只记 warning、下一拍接着写
- ⚠️ 从 v1.1.3 及更早升级的部署要多起一个容器（`prod.sh sync` 换上新 compose 就有），部署 README 和文档站部署页都写了

**实测证据**（2026-11-21，本机真 worker：`--pool=custom` + 一次性 Redis 容器 + 私有 PostgreSQL 库；加了一个临时任务
`probe.sleep(20)` 模拟长任务，派完它 0.5 秒后派 `health.heartbeat`，量心跳键从派发到落地多久）：

| | 心跳落地 | 长任务心跳 |
|---|---|---|
| 修之前（origin/main，单 worker） | **19.54 秒**（排在 20 秒的任务后面） | —— |
| 修之后（两个 worker，`probe.sleep` 派进 `long`） | 0.01 秒 | 长任务跑在 00:24:18–38，长任务心跳在 00:24:27 照写 |

`apps/worker/dev.mjs`：`long@… ready` / `default@… ready`，Ctrl-C 后两个进程退出码都是 0。
单测 `test_task_queues.py` 19 条；变异各自当场红：去掉路由表 · 默认 worker 也写长任务心跳 · 心跳写失败就退出。
`test_health.py` 加了三条（长任务 worker 没起 / 停了都 503 · 调度器停了它照样判得出）。

## 🔴 任务失败提示从来没推出去过 —— 修通之前先收住受众和内容（#400）

**症状**：任务失败，worker 日志里有 `执行失败：…`，页面上没有任何提示；这一节之前的版本还写着「失败照推」。

**根因**：`on_failure` 是同步钩子，celery_aio_pool 的 tracer 只把 `before_start` / `on_success` 交给池的循环，
失败走 celery 自己的 `handle_failure`，在 worker **主线程**上同步调。原来的写法
`asyncio.get_running_loop().create_task(...)` 外包 `except RuntimeError: pass` —— 主线程上没有正在跑的循环，
**每一次**都抛、每一次都被吞。从第一个 Celery 提交（`8f1ad6d`）起就是这样。

而它推的内容是 `执行失败：{exc}`、`sio.emit` 不带房间：直接修通，`autoretry_for=(SQLAlchemyError,)` 重试耗尽后
`str(exc)` 里的完整 SQL、绑定参数、数据库主机会广播给**每一个**在线用户（开始 / 成功那两条也一直是广播）。

**修法**：

- 投递：`asyncio.run_coroutine_threadsafe(..., pool_loop())` 投进 AsyncIOPool 自己的循环（和雪花初始化同一个，#369），不等结果；
  没有池循环（eager / 测试里直接调）只记日志，关掉协程，不往外抛
- 受众：`utils/notify.py: task_watcher_ids` —— 只推给能看执行记录的人（`task:result:list`），按人推进 `user_room`。
  SQL 只粗筛候选，判据一律走 `get_jwt_user` 快照 + `rbac.user_has_perm`（父目录停用、权限码白名单、casbin 只认超管都在那一份里）。
  `common/socketio/actions.py: task_notification` 现在必须传 `user_ids`，没有广播这条路了
- 内容：失败只说「任务 X（id）执行失败，详情见执行记录」；原文在 `task_result` 里，要同一个权限码才看得到
- 节流：同一任务 60 秒内只推一次失败（每 15 秒一次的投递任务在库挂掉时会连续失败）；日志照记每一次

**实测证据**（同上一节的真 worker 环境，临时任务 `probe.fail` 抛一个带主机和密码的 `RuntimeError`，订阅 socket.io 的 Redis 通道看实际发出去的消息）：

| | 「开始执行」 | 「执行失败」 |
|---|---|---|
| 修之前（origin/main） | `room: null`（广播） | **没有这条消息**，日志里只有 `on_failure:104 … 执行失败：… password=hunter2` |
| 修之后 | `room: user:2048601269672738816`（种子 admin） | 同一个房间，`任务 probe.fail（…）执行失败，详情见执行记录` |

单测 `test_task_notify.py` 7 条（在**没有运行中循环**的线程上调 `on_failure`，和 worker 主线程一样）。变异各自当场红：
改回 `get_running_loop` 吞异常 · 消息里带回 `{exc}` · 去掉节流 · 受众不过 `user_has_perm`（菜单停用那条）· `task_notification` 改回广播。
⚠️ 去掉 SQL 粗筛**仍绿**，是等价变异：粗筛只省掉逐个查快照的次数，结论全由 `user_has_perm` 决定。

## 🔴 执行记录一碰到真失败记录就 500：`result` 列不是字符串（#417）

**症状**：「执行记录」列表 / 详情整页打不开，接口 500（`ResponseValidationError: result Input should be a valid string`）。
只要当前页里有一条 worker 真写下的失败记录就会撞上；而 #400 之后失败提示写的正是「详情见执行记录」。

**根因**：`task_result.result` 是 `PickleType`，celery 存什么就是什么 —— 失败的 DatabaseBackend 存
`{'exc_type': ..., 'exc_message': (...), 'exc_module': ...}`，成功的任务返回什么就存什么。响应模型
`GetTaskResultDetail.result` 却声明成 `str | None`。原来的测试造的失败行 `result` 都是字符串，**和 celery 真写的不是一个形状**，
所以一直绿。

**修法**：`schema/scheduler.py: result_as_text` 挂在 `result` 的 `mode='before'` 校验器上，出网前转成一行字：
失败的写成 `exc_type: 参数1, 参数2`（和 traceback 最后一行同样子），其它非字符串转 JSON（中文原样）。契约照旧是 `string | null`，前端不用动。
🔴 造执行记录的测试要按 celery 真实写入的形状造（经 ORM 让 `PickleType` 自己序列化），别再塞字符串。

**实测证据**（2026-11-21）：本机开发库最近 3 条 `FAILURE` 行（`ProgrammingError` / 两条 `NotRegistered`），修之前
`GetTaskResultDetail.model_validate` 3 条全失败，修之后是 `NotRegistered: notification.deliver_pending` 这样的一行。
`tests/test_result_values.py` 8 条（失败 / 无参数 / 多参数 / 字典 / 整数 / 字符串 / 空 七种详情 + 一页混着失败的列表）：
修之前 6 条红（字符串和空两条本来就过）；变异 —— 去掉校验器 6 条红，去掉失败那一支 3 种失败 + 列表红。
