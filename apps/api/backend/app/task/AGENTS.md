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
pnpm dev                        # api + web + worker（worker 含内嵌 beat）
pnpm --filter worker dev        # 只起 worker
```

🔴 **`-B`（内嵌 beat）只用于开发。** 多副本部署时每个副本都跑一个 beat，
同一条调度被触发 N 次。生产要分开，且 beat **只起一个**：

```bash
pnpm --filter api celery:worker   # 可以多副本
pnpm --filter api celery:beat     # 只能一个
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

补在 `celery.py` 的 `worker_process_init` 里。只补「任务代码会用到的全局单例」，
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

### ⚠️ 同一个函数里的 `snowflake.init()` 有同类问题，**还没修**

它在临时循环里 `create_task` 起了节点续期（`utils/snowflake.py: start_heartbeat`），`asyncio.run` 一结束就被取消 ——
worker 占的雪花节点 key 过了 TTL 就没了，下一个起来的进程会拿到同一个节点号，两个进程用同一组
datacenter / worker 发 ID。

**实测证据**（同一次演练，`SNOWFLAKE_NODE_TTL_SECONDS=60`、续期间隔 30 秒）：worker 起来 4 秒时
`fba:snowflake:nodes:0:1` TTL 56，40 秒时 TTL 20（api 那把 `0:0` 同期被续回 37 → 42），66 秒时 worker 还活着、
它那把 key 已经没了；这时再起一个 worker，拿到的还是 `0:1`，两个 worker 同时活着。
**这只证明了「节点号会重复」**，重复的 ID 本身没有实测（要两个进程在同一毫秒、同一序号上发号）。

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
一直要重启 beat 才生效，见下面 #183 一节。

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

🔴 **调度器的心跳必须写在调度循环里，不能也靠派任务**：派出去的任务要 worker 执行才落得了地，
那样 beat 停了和 worker 停了看到的是同一个结果。反过来，beat 不在时 worker 收不到心跳任务，
所以接口把这种情况下的 worker 报成 `unknown`，不报 `stale`。写调度器心跳失败只记日志 ——
不能为了心跳让 beat 停摆。

高频任务的两条纪律（每分钟一次就会显形）：

| 不做会怎样 | 怎么挡 |
|---|---|
| 每次往 `task_result` 写一行 —— 一天 1440 行，「执行记录」页被淹没 | 装饰器上 `ignore_result=True` |
| `TaskBase` 的开始 / 成功提示经 Redis 广播给**所有**在线页面 | 装饰器上 `notify=False`（`tasks/base.py` 认这个类属性；失败照推） |

🔴 **这两条现在有守卫**：`tests/test_scheduler_api.py::test_high_frequency_tasks_neither_record_nor_broadcast`
—— 库里每条启用的、间隔 ≤ 60 秒的调度，任务上都得有这两项。补它是因为 #166 的 `notification.deliver_pending`
（每 15 秒）两项都没关就合进了 main：一天 5760 行执行记录，每 15 秒给所有在线页面推两条提示，CI 全绿。
#167 加 `open.webhook_deliver_pending` 时才发现。变异：去掉通知任务上的两项 → 这条红。
⚠️ 拿注册表要先 `celery_app.loader.import_default_modules()`：autodiscover 是惰性的，不导入就是 `NotRegistered`。

调度那一行的 `expire_seconds = 180`（= 阈值）：worker 停了很久再起来时，排队超过阈值的心跳直接丢掉。

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

## 🔴 页面上停用 / 改 / 删不生效，一条不到期的调度把 beat 整个堵死（#183）

**症状**（下游实测，按时间顺序）：页面上停用一条每天 02:30 的调度，接口 200，第二天 02:30 照样派发；
下次发版重启 beat 之后，**所有**定时任务停了 8 小时 —— beat 只派出一次心跳就再没派过任何任务，
`/health/status` 503 报「worker 心跳停了」（worker 是好的，只是收不到任务），在页面上重新启用也解不开。

**根因**是几个独立的洞叠在一起：

| | 根因 | 修法 |
|---|---|---|
| 写入侧 | crud 的 `update_model_by_column` / `delete_model_by_column` 发的是 Core `UPDATE`，**不触发 mapper 事件**，而变更标记只在 `after_insert/update/delete` 里打 —— 只有新建（`session.add`）通知得到 beat | DAO 的增 / 改 / 启停 / 删调 `TaskScheduler.touch_last_update_after_commit(db)`，挂在 session 的 `after_commit` 上；ORM 事件也改成登记、提交后再打 |
| 写入侧 | 标记打在提交**前**：beat 可能抢先重载、读到旧行，再把标记记成「看过了」，改动照样丢。SQL Server 上那次读还会被未提交的 INSERT 挡住 | 同上，只在提交之后打，回滚不打 |
| 写入侧 | 标记值是 `to_str(now())`、只到秒，beat 只比相等：同一秒里两次改动写出同一个值 | 值带随机后缀 |
| 重载 | celery 的 `schedules_equal` 用 `ScheduleEntry.__eq__`，只比 task / args / kwargs / options / schedule，**不比 enabled / start_time / expire_time / one_off**：只改这几项时判「没变」、不重建堆，堆里的旧 entry 读的是旧 model | 重载过就让 `schedules_equal` 返回 False，强制重建堆 |
| 重载 | celery 的 `reserve()` 是 `self.schedule[name] = next(entry)`：那一读碰上变更标记就重读，再把拿旧 model 算出的下一轮写进新字典 —— 刚停用的调度复活 | 重写 `reserve`，直接写 `_schedule`，重读留给下一拍开头 |
| 堆 | celery 的 `tick()` **只看堆顶，没到期就原样留着**（不弹出、不重新排队）。`ModelEntry.is_due()` 的四种「永远不到期」（停用 / 过期 / one_off 跑过 / 没到 start_time）按 `now + 60` 进堆，这个时间一过就排到堆顶、再也下不来 | 载入时不收前三种（`is_retired`）；tick 之后把堵在堆顶的按它自己报的下次时间挪回堆里（`_requeue_stale_head`）—— 没到 start_time 的、运行中才过期 / 跑完的，只有这一道挡得住。没开始时报「离 start_time 还有几秒」（≤ 60），开始那一刻准时再看 |
| 兜底 | 注释说「max_interval 到点仍会重读」，没有这回事：标记不变就永不重读 | `reload_every = 300` 定时重读（标记漏打、迁移里插的调度） |

⚠️ 挪堆顶只挪「真实下次时间比堆里的位置晚 1 秒以上」的：celery 的 `adjust()` 自带 -10ms 漂移，
普通的「还没到点」两者本来就差这一点，不留余量会在每个调度到点前空转几拍。没重写整个 `tick()`，
是为了少抄 celery 的内部实现 —— 升级 celery 时要核对 `_heap` / `_when` / `event_t` / `reserve()` 还是这个样子。

### 🔴 定时重读自己带进来的四个坑（第一轮修完、二轮审查才抓到）

「每 5 分钟无条件重读 + 每次重读都重建堆」把原来「恰好有人改调度才会撞上」的事，变成了 5 分钟内必然撞上：

| 不处理会怎样 | 修法 |
|---|---|
| 从没跑过的调度 `last_run_at` 回落成「现在」，每次重读都往后挪：**间隔比 5 分钟长的新调度永远不到期**（实测每 10 分钟一次的新调度 3 小时 0 次） | 起点改成建好的时刻（不早于 beat 启动），重读不变；起点规则见下 |
| `_persist` 回写失败（库抖一下，只记 warning）之后重读拿库里旧值：每日任务当天补跑一次，one_off 再跑一次 | 重读时按 id 把内存里更新的触发记录带过来（`_carry_over_run_stats`），`sync()` 之后补回库里 |
| 重读时库连不上：异常经 `tick()` 抛到 celery 的 `start_scheduler`，记一条 critical 就**退出 beat 进程** | 失败只记 warning、沿用内存里的调度，`reload_retry_after = 30` 秒后再试 |
| 指向未注册任务的调度每次重读喊一次 ERROR，一天 288 条，告警被刷屏 | 同一条只喊一次 |

另外两处顺手修的：启动时先读标记再读表（反过来的话两步之间提交的改动会被当成看过了）；同步 Redis 客户端一个进程只建一个
（原来每读一次标记就新建一个客户端 = 一条新的 TCP 连接，挪堆顶带来的额外 tick 会放大它）。

### 🔴 下次触发从哪一刻算起（`ModelEntry._anchor`）

| 这一行 | 起点 | 不这样会怎样 |
|---|---|---|
| 跑过 | 最近一次触发 | —— |
| 没跑过、有 start_time | start_time | —— |
| 没跑过、没 start_time | 建好的时刻，但**不早于这个 beat 进程启动的时刻** | 回落成「现在」：「定时重读」那张表的第一行。直接用建好的时刻：种子的 `created_time` 是固定的 2026-08-22，全新部署第一次起 beat，从没跑过的种子全会当场跑一次 —— 里面有给全员发消息的「每日问候」 |
| 用户改过（含停用后重新启用、改 crontab） | 上面那个和 `updated_time` 取**晚**的 | 重新启用一条每天 02:30 的调度，停用期间错过的那次在点「启用」时当场补跑；把 crontab 改到今天已过的时刻也一样（二轮审查实测，两种都在 10:00 多跑一次）。修之前启停不生效所以没人见过 |

🔴 **beat 自己的回写不能动 `updated_time`**：`_persist` / `sync` 的 Core UPDATE 原来会经 `onupdate` 把它推到回写那一刻
（每触发一次、每 3 分钟 sync 一次都改一遍，界面上的「修改时间」其实是最近一次回写的时间），那就不能拿它当「用户最后一次改」。
现在回写时显式 `SET updated_time = updated_time`（列出现在 SET 里，onupdate 就不生效）。

代价和边界：间隔型调度改个备注也会从改的那一刻重新计时；没跑过、没 start_time、间隔又比 beat 重启周期长的调度，
每次重启都重新计时（和修之前一样）。⚠️ 升级后第一次启动，间隔型调度的下一次可能顺延（不超过一个间隔）：
老代码的回写已经把 `updated_time` 推到了老 beat 退出那一刻。
⚠️ 测试里改调度要显式写 `updated_time`（`test_scheduler_timing.py: _edit`）：列上的 `onupdate=timezone.now` 是定义模型时
绑死的方法，假时钟换不掉，不写的话落库的是真实此刻，在假时钟看来是「未来」，起点会悄悄跑偏。

🔴 **假时钟要连 `time.monotonic` 一起换**：第一轮的模拟只换了 `timezone.now` / `BaseSchedule.now`，跑 12 小时实际只过一秒，
定时重读一次都没发生，上面第一行就这么混过去了。`test_scheduler_timing.py` 的 `clock` 夹具现在三处一起换。

### 🔴 修完上面那条才天天踩得到的：PostgreSQL 下 crontab 按 UTC 的钟点算

PostgreSQL 按会话时区返回 timestamptz（默认 UTC，beat 的同步连接没设时区），而 crontab 的
`remaining_delta` 拿 `last_run_at.day` / `.hour` 直接和本地的 now 比。北京时间 0～8 点两边不是同一天，
下次触发就按 UTC 的钟点算：每天 02:30 的任务，beat 在 02:30 之前启动会**立刻补跑一次**；之后每次重读都按 UTC 算，
02:30 那次干脆挪到 **10:30**。原来只在重启 beat 时重建堆，所以只踩重启那一下；修完「重载必重建堆」再加上每 5 分钟的
定时重读，不换算就天天错。修法在 `ModelEntry.__init__`：`last_run_at` 换算到应用时区。SQL Server 的 `datetimeoffset`
存着写入时的偏移、MySQL 读回来是 naive（`TimeZone` 补成应用时区），都踩不到 —— **只有 PostgreSQL 的 CI 红得出来**。

**实测证据**（2026-10-30，celery 5.6.3 · sqlalchemy-crud-plus 1.13.3 · PostgreSQL 私有库；真实的 `ModelEntry` /
`DatabaseScheduler` / celery `Scheduler.tick()`，只换掉时间、变更标记和派发，按 `beat.Service.start` 的方式驱动假时钟；
「修之后」一列带着每 5 分钟一次的定时重读）：

| 场景（心跳每 60 秒，跑 600 秒） | 修之前 | 修之后 |
|---|---|---|
| 全是启用的（对照） | 心跳 10 次 | 10 次 |
| 一条停用的 / 已过期的 / one_off 已跑过的 | **1 次**，堆顶停在那条 | 10 次 |
| one_off 在 beat 运行中跑完第一次（没重启） | 1 次 | 10 次 |
| start_time 在一小时后（跑 2 小时） | 第一小时只有 **1 次** | 第一小时 60 次 |
| 150 秒时停用一条每 2 分钟的（库里已停、标记已打） | 之后照派 240 / 360 / 480 | 不再派 |
| 已堵住，300 秒时重新启用并打标记 | 心跳之后 0 次 | 恢复 |
| 每天 02:30，03:00 重载一次，跑到 14:00 | 原代码：02:00 启动即补跑 | 只有 02:30 |
| 新建一条每 10 分钟的（跑 3 小时） | — | 17 次，第一次在 600 秒（只修第一轮时 0 次） |

crud 打不打事件（真实 `task_scheduler_dao`）：ORM add 1 次，`set_enabled` / `update` / `delete` **各 0 次**。
SQL Server（本机容器，RCSI 关着，同 CI）：本模块 + `test_health.py` 134 条全过；把 ORM 事件改回提交前当场打、
去掉接口测试探针的锁超时，那条接口测试**卡住**（90 秒被杀）—— 二轮审查推断的死锁是真的。

守卫 30 条新用例 + 1 条改写：`test_scheduler_api.py::test_every_write_tells_beat_after_it_commits`
（打标记时另开连接读那一行，读到新值才算「提交之后」；SQL Server 上设了 1 秒锁超时，提交前被调到会快速红而不是卡死）·
`test_scheduler_timing.py` 里 #183 那两节（假时钟 + 真库 + 真 tick）· `test_scheduler.py` 的载入过滤 / 标记不重复 /
时区换算 / 标记写失败 / 未注册只喊一次 / Redis 客户端复用。原 10 条只 tick 一次的用例改成 `tick_until_idle()`
（种子里从没跑过的调度现在和用例的行同时到期，一拍只派堆顶那一条）。
27 处变异各有对应的红：新建（DAO 和 ORM 事件都去掉）/ 编辑 / 启停 / 删除不打标记 · 提交前打 · 去掉挪堆顶 · 去掉载入过滤 ·
去掉强制重建堆 · 去掉 `reserve` 重写 · 去掉时区换算 · 标记只到秒 · 去掉定时重读 · 重读失败往外抛 · 失败后不隔开 ·
去掉 `_persist` · 没跑过的回落成「现在」· 去掉触发记录带过来 · 启动先读表 · 没开始固定 60 秒 · ORM 事件当场打 ·
未注册每次都喊 · 标记写失败不接 · 每次新建 Redis 客户端 · 起点不看 updated_time · 没跑过的不垫到启动时刻 ·
`_persist` / `sync` 回写动 updated_time（各一处）。
⚠️ 只去掉「强制重建堆」时停用那条**仍绿**（停用的行载入时就不收，键集合一变 celery 自己会重建）—— 抓它的是
「改 start_time / expire_time、行还在调度里」那条；只去掉 DAO 里新建那次登记也仍绿（ORM 事件兜着），两样都去掉才红。

⚠️ **没修的**：① 调度器心跳写在 `tick()` 里，beat 因为别的原因不派任务时心跳照写，`/health/status` 仍然只会报
「worker 心跳停了」，分辨两者要另记一个「最近一次派发」的时间。② 写入侧靠 DAO 显式登记，绕过 DAO 直接写这张表的
（原生 SQL、迁移）要等定时重读；更彻底的是在 Session 级挂 `do_orm_execute` / `after_flush` 统一登记，但要排除 beat 自己的
回写，留给后续。③ 「提交后做一件事」后来抽成了公用的 `common/after_commit.py: run_after_commit`（通知推送 / 通知投递 /
Webhook 投递都走它，#190 迁完）；**这里的变更标记刻意没迁**：它挂在同步会话上、提交后做的是一次同步的 Redis 写，公用那份派的是协程。
