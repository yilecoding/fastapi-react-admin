# app/task —— 定时任务（Celery）

> Celery worker / beat、调度表、执行记录。和 `app/admin` **平级的独立 app**，
> 不是插件 —— worker 是独立进程，要能脱离 FastAPI 启动，插件的动态装载服务不了它。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载）。跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。
> 新增结论请追加到这里，写完跑 `pnpm ctx:check`。

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

`tasks/maintenance/` 里两个任务都会删数据，而且自动跑。三条：

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
