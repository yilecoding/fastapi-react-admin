# app/task/utils —— beat 的调度器（`schedulers.py`）

> `DatabaseScheduler` / `ModelEntry`：beat 从 `task_scheduler` 表读调度、算下次触发、回写触发记录。
>
> 这份文件是 [`app/task` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。
>
> 调度只有一个来源（`task_scheduler` 表）· 指向未注册任务 · 触发计数立刻落库 这几条还在上一级分册里。

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
