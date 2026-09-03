# 浏览器自动化编排 —— 技术设计

> 状态：**设计定稿，未开工**（地基那一块已合：`run_as()`，见下面「已完成」）。
> 这份文档放在 `docs/workflow/` 而不是 `docs/` 根下，是为了让文件名是 `README.md` ——
> `pnpm ctx:check` 只核对 `CLAUDE|AGENTS|README|CONTRIBUTING|SECURITY|PULL_REQUEST_TEMPLATE`
> 这几种文件名（`scripts/ctx-check.mjs`），换个名字这份文档里的几十条路径引用就不再有人核对，
> 而它们是最容易静默腐烂的东西。
>
> 因此本文的写法约定：**反引号里的路径一律是本仓库的**（受闸门核对，写错会红）；
> 外部仓库（TestPilot）和第三方库的文件名用普通文本，闸门不管、也不该管。

## 一、范围

**要解决的痛点，一句话：** 把一串浏览器操作编排起来，然后能被定时或手动触发执行，
执行过程留证据。典型场景是「每天登录某个系统」「每周去某站点导一份数据」——
这些操作本身很普通，烦的是每天都要人做一遍。

### 做

| | |
|---|---|
| 编排 | 把 N 个步骤排成一条流程，顺序执行，失败即停 |
| 浏览器执行 | 步骤里最重要的一类：打开页面、登录、点击、填表、抓取、截图 |
| 触发 | 定时（crontab）+ 手动 |
| 留痕 | 每步的输入/输出/耗时/错误，失败留截图 |
| 权限 | 流程归谁、以谁的身份执行，都受现有 RBAC 与行级数据权限约束 |

### 明确不做（第一期）

| 不做 | 为什么 |
|---|---|
| 拖拽画布 | RPA 类流程的节点粒度极细，一条真实流程 50–100 步，自由画布在 50+ 节点时找不到节点、连线成团。步骤列表在 100 步时反而清晰。**画布不是"以后再做的高级版"，很可能不是这个场景的正确形态** |
| 分支 / 循环 / 并发 | 多数「省掉手工操作」类流程是线性的。语义一旦开放，就要配表达式引擎、重试粒度、并发语义 —— 那是另一个数量级的工程 |
| 面向业务人员的 RPA 产品 | 不做录制器、不做元素拾取器、不做多租户治理。用户是开发/运维自己 |
| 通用编排平台 | n8n / Dify 那类是整团队做几年的东西。这里是「给 admin 加一种能力」，不是做一个新产品 |

🔴 **这张「不做」表是这份设计最重要的部分。** 编排类需求的失败方式不是做不出来，
是范围无声膨胀 —— 每一条单看都合理，加起来就变成了一个做不完的平台。

## 二、形态决定

### 1. 做成 admin 的后端插件

`apps/api/backend/plugin/workflow/`，结构照 `apps/api/backend/plugin/notification/` 抄
（`plugin.toml` + `api/` + `crud/` + `model/` + `schema/` + `service/` + `sql/{mysql,postgresql,sqlserver}/` + `tests/`）。

插件机制已经解决了「可拔插」：`[app] extend = "admin"` 挂进主应用、`[api.*]` 声明路由前缀、
`requirements.txt` 自带依赖、`sql/` 灌菜单和权限码种子、Redis 存启用开关、
`fba install/remove plugin` 装卸。**这块不需要设计，只需要照抄。**

### 2. 触发层复用 `task_scheduler`，不新建调度

`apps/api/backend/app/task/model/scheduler.py` 的 `task_scheduler` 一行 = 一个 Celery 任务名
 + 一个 crontab + args/kwargs。它是**触发器**，没有节点、没有依赖、没有数据流 ——
所以它不能当编排表用，但可以当编排的触发层：

```
task_scheduler 插一行： task='run_workflow', kwargs={'workflow_id': '...'}
```

beat、调度管理页（`packages/platform/src/pages/scheduler-manage/`）、
执行记录页（`packages/platform/src/pages/scheduler-record/`）全部不用重做。

### 3. 数据模型按图存，UI 按列表渲染

存 `nodes` + `edges` 两个 JSON 列，线性阶段 `edges` 就是 `i → i+1`、`condition` 全为 null。
UI 第一期渲染成步骤列表（上下拖拽排序，`@dnd-kit` 已在仓库里）。

代价几乎为零，收益是把一次必然发生的重构提前消掉：**将来上画布只换渲染层，一行数据都不用迁**。
反过来，第一版图省事存成 `steps: [...]` 数组，加分支时就是一次数据迁移 + 所有已配置流程重建。

⚠️ node id 用雪花（硬纪律 6），**不要用数组下标当 id** —— 下标会因为插入/删除步骤而漂移，
而执行记录里引用的正是它，漂了之后历史记录静默指向错误的步骤。

### 4. 引擎与节点执行器分离

```
admin 侧（引擎）        ：流程推进、变量传递、超时、失败处理、留痕、权限
节点执行器（可远程）    ：具体干活的
  ├─ http / delay / notify  → 本地执行，很轻
  └─ browser                → 重，见第五节
```

浏览器那类节点做成**远程执行节点**，admin 只管流程推进。这样浏览器的进程管理、
并发预算、会话复用、录制留痕都不用在 admin 里重做一遍。

## 三、数据模型

三张表。**不是两张** —— 每步留痕必须是独立的行，塞进 run 的一个大 JSON 列会让
「看某一步的输出」变成解析整个流程的历史。

### `wf_workflow` —— 流程定义

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | 雪花 | |
| `name` | `UniversalStr(64)` | |
| `description` | `UniversalText` | |
| `nodes` | `UniversalText` | JSON：`[{id, type, name, config}]` |
| `edges` | `UniversalText` | JSON：`[{from, to, condition}]` |
| `run_as_id` | 雪花 | 🔴 **执行身份** —— 以谁的身份执行，见第四节 |
| `version` | int | 每次保存 +1，实例快照记录它 |
| `enabled` | bool | |
| `deleted` / `created_time` / `updated_time` | | 跟仓库惯例 |

⚠️ JSON 列用 `UniversalText` 而不是 `sa.JSON()`：SQL Server 下 SQLAlchemy 把 `sa.JSON`
映射成 NVARCHAR(max)，等于就是字符串，但类型注解会和实际返回的 dict/list 对不上 ——
`task_scheduler` 已经为此改过一轮（见该模型的文件头注释）。

### `wf_run` —— 流程实例

| 列 | 说明 |
|---|---|
| `id` / `workflow_id` | |
| `snapshot` | 🔴 **启动时的定义快照（JSON）** |
| `snapshot_version` | 快照对应的 `wf_workflow.version` |
| `status` | pending / running / success / failed / cancelled |
| `trigger` | manual / schedule |
| `started_by_id` | 谁触发的（≠ `run_as_id`，见第四节） |
| `context` | JSON 变量池，步骤输出往里写 |
| `error` | 失败原因 |
| `started_time` / `finished_time` | |

🔴 **`snapshot` 是刻意的冗余。** 「流程改了，正在跑的实例用哪一版」这个问题必须在
第一天答掉 —— 不存快照的话，改一次流程就可能把在跑的实例搞崩（步骤删了，引擎推进到
一个不存在的 node）。存了快照，正在跑的实例读自己那一份，改动只影响下一次启动。

### `wf_step` —— 每步留痕

| 列 | 说明 |
|---|---|
| `id` / `run_id` | |
| `node_id` | 快照里那个 node 的 id（字符串，雪花） |
| `seq` | 第几步 |
| `status` | pending / running / success / failed / skipped |
| `input` / `output` | JSON |
| `error` | |
| `artifacts` | JSON：截图/录屏的 `sys_file` id 列表 |
| `started_time` / `finished_time` | |

## 四、执行身份（已完成）

### 症状

`DataScopedCRUD._data_scope_condition()`（`apps/api/backend/common/security/data_scope.py`）
的用户来自 ContextVar，不是 Request。拿到 `None` 时它**返回 None，不加任何过滤**。

对定时清日志那类「不代表任何人」的任务这是对的。但编排流程是**代替某个人**读写业务数据的：
定时触发时没有请求上下文 → `_current_user` 是 None → **行级权限静默 fail-open**，
那个人只该看到本部门的行，流程查回了全库。不报错、不 403，只是行数变多。

RBAC 拦不住这个：权限码在 API 依赖里判，而走 Celery 的路径根本不经过 API 依赖。
两层的失效方式完全不同。

### 修法

`run_as(user)` contextmanager（已合，与 `bypass_data_scope()` 对称）。引擎把整个流程的执行
包在里面：

```python
async with async_db_session() as db:
    user = await user_dao.get(db, workflow.run_as_id)
with run_as(user):
    ...   # 这段里的 DAO 读会按 user 的数据范围过滤
```

🔴 **它拒绝 `None`。** 允许 None 等于给 fail-open 开一个看起来合法的后门 ——
调用方会以为「我包了 `run_as`，权限是继承的」，而实际上什么都没继承。

### 实测证据

三条守卫在 `apps/api/backend/app/admin/tests/security/test_data_scope_coverage.py`，
每条都做过变异验证（注入变异 → 确认是对应那条测试变红）：

| 注入的变异 | 抓到它的测试 |
|---|---|
| 去掉 `finally` 里的 reset | `test_run_as_restores_identity_on_exit` |
| 根本不设身份 | `test_run_as_makes_a_non_request_context_filter` |
| 允许 `None` 混进来 | `test_run_as_rejects_none` |

其中「退出必须还原」守的是 `celery_aio_pool` **特有**的风险：它把所有任务跑在
**同一个事件循环、同一个线程**里（`new_event_loop()` + 独立线程 `run_forever()`
+ `run_coroutine_threadsafe`，读自 celery_aio_pool 的 pool.py）。ContextVar 设了不还原，
下一个任务就顶着上一个任务的身份跑 —— 跨用户数据泄漏，而两个任务各自看都正常。

### `run_as_id` 与 `started_by_id` 是两件事

- `run_as_id`：**以谁的身份执行**（决定数据范围）。定时触发时没有「当前用户」，所以它必须存在定义上
- `started_by_id`：**谁触发的**（审计）。手动触发时是操作者，定时触发时为空

两者混成一个字段，定时触发就没有身份可用，又回到 fail-open。

## 五、浏览器节点：两条路

### 已实测的两条硬约束

| 验证 | 结果 |
|---|---|
| async Playwright 能否在 `celery_aio_pool` 的非主线程事件循环里起浏览器 | ✅ **能**，1.6s 起来。历史上 `asyncio` subprocess 在非主线程循环里会炸，Python 3.13 下不复现 |
| `with_timeout`（`asyncio.wait_for`）超时后 chromium 是否回收 | 🔴 **泄漏 10 个进程**（超时前 0 → 超时后 10），脚本退出后仍是 10，只能手动 kill |

第二条是这一节的关键：`apps/api/backend/app/task/tasks/base.py` 的 `with_timeout` 用
`asyncio.wait_for()`，它取消**协程**但不杀**进程**。一个 chromium 实例带渲染/GPU 等约 10 个进程，
跑几十次超时就把 worker 内存吃光 —— 而 `celery_aio_pool` 是单进程，没有 prefork 的进程回收兜底。
表现是「worker 内存莫名吃满」，没人会联想到某个任务的超时。

**任何浏览器节点的实现都必须在 `finally` 里显式 kill 浏览器**，光靠超时保护不够。

### 路 A：接 TestPilot（推荐）

<https://gitlab.avc.co/agent/testpilot> —— 公司内部的 agentic E2E 测试平台，技术栈和 admin
几乎同构（FastAPI + SQLAlchemy 2 asyncio + alembic + Celery + Redis + React/Vite/Tailwind）。
它的执行层已经把这些做完了：

| 需要的能力 | TestPilot 现状 |
|---|---|
| 超时后进程回收 | executor.py 的 `finally: browser.kill()`；`stop()` 用来 flush 视频 |
| 并发不失控 | engine.py 的进程级 `Semaphore` 浏览器预算 + leasing.py 的账号租约 |
| 凭据加密 | Fernet（不是 CBC） |
| 不依赖选择器 | browser-use 的 LLM agent 每次看页面自己找元素 |
| 会话复用（省掉登录） | executor.py 的 `capture_session()` 用 CDP 抓完整会话包（cookies + localStorage + **sessionStorage**）存下来，下次以登录态开始 |
| 简单验证码 | agent 提示词里明确要求读页面上的算术/文字验证码 |
| 失败可查 | mp4 + 每步截图 + 可重放的 action history JSON |
| 实时进度 | SSE |

⚠️ **Playwright 的 `storage_state` 会丢 `sessionStorage`** —— TestPilot 为此改用 CDP
`Storage.setCookies` + document-start 注入。这条坑值钱：靠 sessionStorage 存 token 的系统，
用 `storage_state` 恢复会话看起来成功、实际未登录。

**它缺的只有「定时触发用例」**：celery_app.py 的 `beat_schedule` 只有三条
（GitLab 轮询、每小时邮件提醒、每分钟回收僵尸 run），而那条邮件提醒的注释明确写着
`does not auto-run`；models.py 的 16 张表没有任何 cron/schedule 字段。

接法：admin 侧的 `browser` 节点 = 调 TestPilot 的 `POST /projects/{pid}/runs`，
轮询或订阅结果。admin 只管编排和展示。

### 路 B：admin 自建

要从零解决进程管理、并发预算、会话复用、录制留痕，还要给 `fba-api` 镜像装
Python 版 playwright + chromium + 系统库（几百 MB，而且 worker 和 api 现在共用一个镜像 ——
等于 API 也白背一个浏览器，得先拆镜像）。

**只在 TestPilot 不可用（比如目标系统在内网、TestPilot 到不了）时才走这条。**

### 桌面端那条岔路

目标系统如果不是网页（C/S 架构的老 ERP、税务客户端那类），CDP 完全没用 ——
要 Windows UI Automation 拿控件树，拿不到就退到图像识别 + 坐标点击，而且**必须跑在用户的
Windows 机器上**。这条路的载体是 `apps/desktop`（Electron，已在用户机器上跑着）。

**第一期不做**，但架构上留出「节点执行器可远程」这个接口，将来桌面端就是另一种远程执行器。

## 六、执行引擎

```
run_workflow(workflow_id, trigger, started_by_id)
  ├─ 读定义 → 写 wf_run（含 snapshot）
  ├─ 取 run_as_id 对应的 user
  └─ with run_as(user):
       for node in 线性遍历(snapshot):
         ├─ 写 wf_step（running）
         ├─ 渲染 config 里的变量引用（读 wf_run.context）
         ├─ await asyncio.wait_for(执行器(node), timeout=node 自己的超时)
         ├─ 输出写回 context + wf_step（success）
         └─ 失败 → wf_step（failed）+ wf_run（failed）+ 通知 → 停
```

### 四条纪律

1. 🔴 **每步独立超时。** `with_timeout` 是包在**任务函数**那一层的，一个流程十个节点只能
   整流程一个超时。引擎必须自己对每一步 `asyncio.wait_for`。
   注意 `settings.CELERY_TASK_TIME_LIMIT` 那条注释：celery 标准的
   `task_time_limit` / `task_soft_time_limit` 对这个 worker pool 是 **no-op**
2. 🔴 **重节点必须在 `finally` 里显式关闭资源。** 见第五节的实测 —— 超时只取消协程
3. ⚠️ **单事件循环。** 所有流程实例共享一个 loop。任何同步阻塞调用会卡死**整个 worker**
   的所有任务，不只是自己。浏览器节点必须用 async API
4. ⚠️ **失败记录不要依赖雪花初始化。** `apps/api/backend/app/task/model/result.py` 刻意不用
   雪花主键，理由写在它的文件头：让「记录一次失败」依赖另一套初始化成功，等于雪花一挂
   连失败都记不下来。`wf_step` 的失败写入同理

### 变量传递

第一期只做点路径取值，**不引表达式引擎**：

```
{{ steps.<node_id>.output.<字段路径> }}
{{ vars.<名字> }}
```

一旦开放表达式（算术、比较、函数调用），就要处理求值安全、错误提示、类型 —— 那是分支功能
一起做的事，不是第一期。

## 七、节点类型（第一期）

| type | 干什么 | 备注 |
|---|---|---|
| `browser` | 一段浏览器操作 | 核心。走第五节的路 A |
| `http` | 发一个 HTTP 请求 | 最通用的兜底节点 |
| `delay` | 等待 | |
| `notify` | 发站内通知 | 复用 `apps/api/backend/plugin/notification/` |
| `condition` | 条件判断 | **预留**：第一期只实现「不满足就停」，不做分支 |

## 八、🔴 凭据：这一块做错了是泄露事故

### 症状

要自动登录别的系统，就得存别人系统的账号密码 —— **可逆加密**，不能像用户密码那样哈希。
而 `apps/api/backend/middleware/opera_log_middleware.py` 的 `desensitization()` 是
**顶层 key 黑名单，不递归**：

```python
for key in args:
    if key in settings.OPERA_LOG_REDACT_KEYS:
        args[key] = '[REDACTED]'
```

名单只有四个（`password` / `old_password` / `new_password` / `confirm_password`，
见 `apps/api/backend/core/conf.py`）。而流程节点的 config 必然是嵌套的 ——
`{"steps":[{"action":"fill","value":"真密码"}]}` 里的 `value` 既不在名单里、又在第三层，
**必定明文落进 `sys_opera_log.args`**。之后任何有 `log:opera:*` 的人都能在操作日志页看到，
还能导出 CSV。

### 修法（三条一起）

1. **凭据永远不走流程 config。** 节点里只存凭据 id，明文只在「创建/更新凭据」那一个接口出现
2. 那个接口的路径进 `OPERA_LOG_PATH_EXCLUDE`（照 `/auth/login/swagger` 已有的做法）
3. `desensitization()` 改成递归 —— 这条独立于本功能，是现有的洞

### 加密选型

`apps/api/backend/utils/encrypt.py` 的 `AESCipher` **零调用方**（上游带来没人用），
且是 **AES-CBC 无认证**（只有 padding，没有 MAC）。**不要用它存凭据。**
用 AES-GCM 或 Fernet（TestPilot 用的就是 Fernet）；密钥走环境变量，不进库；
接口**只能写入不能读出**，永远不返回明文。

## 九、与现有系统的接线点

动手时逐条对，漏一条的失败方式都是静默的：

| 要接的 | 怎么接 | 漏了会怎样 |
|---|---|---|
| 迁移 | `pnpm db:revision` → **读一遍生成的文件** → `pnpm db:upgrade`。先读 `apps/api/backend/alembic/AGENTS.md` | `test_model_matches_migrations` 会红（这条是整套约定的支点） |
| 数据权限表态 | 新 DAO 继承 `DataScopedCRUD`，或写进 `test_data_scope_coverage.py` 的 `EXEMPT` 并给理由 | `test_every_crud_class_uses_the_scoped_base` 会红 |
| 权限码 + 菜单 | 插件的 `sql/{mysql,postgresql,sqlserver}/init_snowflake.sql`，三个方言各一份，配 `destroy_snowflake.sql`。照 notification 插件抄 | 装了插件但侧边栏没入口 |
| 前端页面注册 | `apps/web/src/lib/page-registry.tsx` + `apps/web/src/routes/**`（只声明守卫，`component: () => null`）| 硬纪律 3 |
| 页面 router-独立 | `search`/`params` 只走 props。有闸门 `pnpm arch:check` | 硬纪律 1 |
| 视图状态进 URL | 筛选/分页/选中进 `validateSearch`。**画布 pan/zoom 是否进 URL 要提前定**（进了很难看，不进就丢） | 硬纪律 2 |
| 雪花 ID | 全链路 string，不 `Number()` | 硬纪律 6 |
| i18n | 文案进 `packages/i18n`，跑 `pnpm i18n:check` | |
| 列表页状态位 | 走 `packages/platform/src/pages/_shared/list-query.ts` 的 `listState()` | 硬纪律 9 |
| 实时进度推送 | socket.io 已挂 `/ws`，见 `apps/api/backend/common/socketio/actions.py` | 见下面那条冲突 |

### ⚠️ 一条设计纪律冲突，要提前定规矩

`apps/api/backend/common/socketio/actions.py` 里 `notification_new` 的注释写着：
事件**刻意不带内容**，因为带上内容就意味着 socket 这条通道也要做一遍「这个人能不能看这条」
的权限判断，而它没有请求上下文、没有 RBAC 依赖链，做出来的一定是第二套、会和 REST 那套慢慢漂移。

而执行进度和实时截图**必须**带内容。规矩定成：

- socket 上只推**执行状态和截图帧**，且只推给 `user_room(started_by_id)`
- **绝不推业务数据**。流程抓到的数据只给引用，前端拿引用走 REST 重新拉
- 权限判定仍然只有 REST 一处，socket 只是投递通道，不做授权决策

## 十、分期

| 期 | 内容 | 判据 |
|---|---|---|
| **0（已完成）** | `run_as()` 执行身份原语 + 三条变异验证过的守卫 | 已合 |
| **1** | 三张表 + 迁移 + 引擎（线性）+ `http`/`delay`/`notify` 三种节点 + 手动触发接口 | curl 能跑通一条三步流程，`wf_step` 里三行留痕齐全 |
| **2** | `browser` 节点（接 TestPilot）+ 凭据表（Fernet，不进日志） | 能跑通「登录某系统并截图」 |
| **3** | 定时触发（`task_scheduler` 插行）+ 失败通知 | 配一条 crontab，第二天自己跑了 |
| **4** | 前端：流程列表页 + 步骤列表编辑器 + 执行记录/回放 | 不写 JSON 也能配一条流程 |
| **5** | 实时进度 / 截图流（socket.io） | 能看着它跑 |
| 以后 | 分支 / 循环 / 表达式 / 画布 | **到这一步再决定要不要**，那时已经知道真实流程长什么样 |

## 十一、未决问题

1. **目标系统的登录卡点是什么** —— 无验证码 / 简单图形验证码 / 短信 / 滑块。这决定
   `browser` 节点是纯 Playwright 脚本还是必须走 LLM agent。滑块和人脸基本堵死这条路，
   得换成「续 cookie 而不是重新登录」
2. **TestPilot 实例部署在哪** —— admin 的 worker 能不能网络到达它
3. **有没有非网页的目标系统** —— 有的话第五节那条桌面端岔路要提前进架构，不是以后再加
4. **画布的视图状态与硬纪律 2 的关系** —— 见第九节
