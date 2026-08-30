# 前端 E2E（Playwright）

> 完全隔离的第二套实例：web :1126 → api :8001 → fba_test。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 前端 E2E（Playwright）

`apps/web/e2e/`。选 Playwright 而不是 Vitest + jsdom + mock fetch，理由和后端测试
是同一套哲学：backend 的 23 条测试打的是真实 SQL Server，不 mock 数据库；前端
配套的自然选择是打真实 dev server + 真实接口，不是隔着一层 mock 测「我以为它会
这样」。全站组件挂的 `data-testid`、硬纪律 5 讲的隐藏 tab 锁定规则，都是照着
「以后会有 E2E」这个假设写的。

```bash
pnpm e2e                          # = turbo e2e，起隔离环境 + 跑 chromium
cd apps/web && pnpm e2e -- tests/dept-crud.spec.ts   # 只跑一个文件
```

### 完全隔离的第二套实例，不跟 `pnpm dev` 共用任何东西

```
web :1126  →  api :8001  →  fba_test（不是开发用的 fba）
```

三处隔离，缺一个都会互相污染：

| 隔离点 | 怎么做的 | 不隔离会怎样 |
|---|---|---|
| 端口 | `vite.config.ts` 读 `E2E_WEB_PORT`（未设置时还是 1125）；api 走 `apps/api/package.json` 的 `e2e:server` 脚本，`ENV_FILE=.env.e2e` 覆盖到 8001 | 跟 `pnpm dev` 撞端口，`strictPort` 直接报错退出 |
| 数据库 | `.env.e2e` 把 `DATABASE_SCHEMA` 设成 `fba_test`（复用 pytest 已经在用、已经建好种子的那个库，不是另开一个） | E2E 造的测试部门/角色会写进你正在手测的开发库 `fba`，脏数据混进日常开发 |
| Redis | `.env.e2e` 把 `REDIS_DATABASE` 换成 `2`（dev 用 0，celery 用 1） | `fba_test` 和 `fba` 是从**同一份**种子脚本建出来的，`admin` 用户在两边的雪花 ID
**完全相同**（实测确认：`2048601263834267648`）。共用 Redis 会让 E2E 一登录就用
`fba_test` 的用户信息覆盖掉你本机 dev session 的缓存 —— 表现是「跑完一轮 E2E，
自己在开发环境里的登录态莫名其妙变了」 |

`.env.e2e` 不进 git（模式同 `.env`），照 `.env.e2e.example` 抄一份，`fba_test`
库本身用 `pnpm --filter api test:db` 建（和 pytest 共用同一个库、同一条建库路径，
见上一节「跑测试」）。

### 🔴 脚本名不能叫 `e2e`（api 那边）

`turbo.json` 的 `e2e` task 按**脚本名**匹配，`apps/api` 和 `apps/web` 两个包如果都有
一个叫 `e2e` 的脚本，`pnpm e2e`(=`turbo e2e`) 会把两个都当独立任务并行起——而
Playwright 自己的 `webServer` 配置**又会**再起一次 api 实例，两个进程抢同一个
8001 端口。实测踩过：`address already in use`，凑巧没影响那一轮的测试结果，
但那是巧合不是保证。所以 api 那边的脚本故意叫 `e2e:server`，只由 Playwright 的
`webServer.command` 调用，不给 `turbo e2e` 一个能匹配上的名字。

### 🔴 验证码不能只靠 `.env.e2e` 关

`.env.e2e` 里 `LOGIN_CAPTCHA_ENABLED=false`，但这个值会被 **sys_config 表的种子
数据在运行时覆盖回去**（`load_user_security_config` 会把 `sys_config` 的值
`setattr` 到 `settings` 上，覆盖 `.env` —— 参数配置那节说的就是这条）。
只改 `.env.e2e` 不够，`fba_test` 里那条种子值也要跟着改。

`global-setup.ts` 做的正是这件事：用 `/auth/login/swagger`（给 API 测试用的
便捷接口，不校验验证码，和真实登录表单走的 `/auth/login` 是两个接口）登录拿
token，再 `PUT /sys/configs/{pk}` 把这条配置在 `fba_test` 里也改成 `false`。
这样`login.spec.ts`（驱动**真实**登录表单）看到的验证码也是关的，不用在测试代码里
解验证码图片。

### 🔴 CI 里的环境变量优先级会覆盖 `.env.e2e` 文件

`.github/workflows/ci.yml` 那个叫 `.env.e2e` 的准备步骤曾经实际写的是
`cp backend/.env.example backend/.env`——而这个 job 全程 `ENV_FILE: .env.e2e`，
没有任何进程会去读 `.env`。`backend/.env.e2e` 在 CI 里因此从来没被真正创建过：
`core/conf.py: _ensure_env_file()` 发现它缺失，会静默地从 `.env.example`
自动生成一份空白替身（这是给本地开发用的兜底，触发在 CI 里纯属意外），
日志里只有一行不起眼的警告，不会让任何一步失败。

更致命的是第二层：**job 级 `env:` 里的 OS 环境变量优先级高于 dotenv 文件**
（pydantic-settings 里 `env_settings` 排在 `dotenv_settings` 前面）。就算把
`.env.e2e` 文件本身修对了，job 级 `DATABASE_SCHEMA: fba` 依然会覆盖文件里写的
`DATABASE_SCHEMA='fba_test'`——E2E 真正跑起来的 `api:e2e` uvicorn 进程会连到
只 `CREATE DATABASE`、从没跑过 alembic 也没灌过种子的开发库 `fba`。dev 模式
启动会自动 `create_all` 建表（几秒内完成），所以连接看起来完全正常，就是没有
`admin` 账号——`global-setup.ts` 登录直接 403「用户名或密码有误」，看着像
环境没配好，其实是两层配置各自独立地指错了地方。

`DATABASE_SCHEMA: fba`（不是 `fba_test`）这条本身没错——**别的**步骤要靠它：
「重建测试库」调用 `get_database_url(unittest=True)`，自己在这个值后面拼
`_test` 后缀，看的是「基准库叫什么」不是「这个值该指向哪」。但 E2E 真正跑起来
的 api 服务器是脱离那层推导的独立进程，需要的是**结果**（`fba_test`）本身。

实测复现：本地起一个刚 `CREATE DATABASE`、没有任何表和种子的空库，
指给 `api:e2e:server`，dev 模式 `create_all` 建表后连接正常、返回准确是
`403`（不是 500）——和 CI 上观察到的现象完全一致。

修法两处都要改：

- `.env.e2e` 准备步骤改成 `cp backend/.env.e2e.example backend/.env.e2e`——
  照抄本地开发的路子，这份 example 里的 DB/Redis host/port/密码本来就是照
  CI 的 service 配置写的，不用替换任何字段
- 「E2E test」这一步单独覆盖 `env: DATABASE_SCHEMA: fba_test`，把 job 级的
  `fba` 盖回来——**加新的 CI 环境变量覆盖前，先想清楚它会不会连带影响到
  同一个 job 里另一个不该受它影响的步骤**

### 🔴 `storageState` 在这个应用上走不通，登录态靠 `addInitScript` 注入

Playwright 常规的「登一次、存 `storageState.json`、后面测试全复用」这条路，在这个
应用上失效：access token 存在 **sessionStorage**（`api-client/token-store.ts`，
注释写着为什么不用 localStorage），而 Playwright 的 `storageState` 机制只保存
cookies 和 localStorage，**不包括 sessionStorage**。而且这个应用的路由守卫
（`isAuthenticated()`）是纯同步读 sessionStorage，不会在页面启动时用 refresh
cookie 静默换一个新 access token（那个刷新逻辑只在请求收到 401 时才触发）——
两条凑在一起，「存好登录态复用」这条路完全走不通。

`fixtures/base.ts` 的 `authedPage` 改成：每次都用 `/auth/login/swagger` 现登一次
拿 token，再 `page.addInitScript()` 在导航前把它塞进 sessionStorage。access token
一天才过期（`TOKEN_EXPIRE_SECONDS`），不用担心一次测试跑太久失效。

### 🔴 `<Activity>` 会把 effect 整个销毁重建 —— 这条抓到了一个真 bug

`tabs.spec.ts` 第一条测试（折叠一个树节点、切 tab、切回来）第一次跑就抓到一个
真实的 bug，不是测试写错：`_shared/use-tree-fold.ts` 原来用
`useEffect(() => setFlipped(new Set()), [foldAll])` 在 `foldAll` 变了的时候清空
手动展开/折叠的记录。但 `<Activity mode="hidden">` 切回可见时会把这个组件的
effect **整个销毁重建**（`tab-outlet.tsx` 那条注释：「销毁 effects（订阅被清理，
不会 refetch 风暴）」）——一个新建的 effect 不管依赖数组里的值是什么，
挂载时都会跑一次。于是每切一次 tab 回来，这条 effect 就会误判成「foldAll 变了」，
把用户手动折叠的节点清空——`flipped` 这个 state 本身被 Activity 保活得好好的，
是这条 effect 自己把它清空的。

修法是用 `useRef` 记住「上一次真正生效的 `foldAll`」，effect 里先比对再决定要不要
清空——ref 和 state 一样是 Activity 保活的，只有 effect 本身被摘掉重建，这条比对
才立得住。**这个坑不只 `useTreeFold` 会踩**：任何一个「靠 `useEffect` 响应某个值
的变化」的写法，只要那个组件会被 Activity 隐藏又显示，都有同样的风险——
`[依赖]` 数组能不能正确分辨「真的变了」和「effect 刚被重建」，取决于比较的是
不是持久存在的东西（ref/state），不是 effect 自己的执行次数。

### 种子 SQL 里不能加裸注释块

`backend/utils/sql_parser.py` 靠白名单前缀（`SELECT/INSERT/SET/DO`）校验种子脚本，
`sqlparse.split()` 会把一段独立的注释和它后面紧跟的语句合并成**一个** chunk，
但校验时 `.strip().lower().startswith(prefix)` 看的是这个 chunk 的开头——
开头是注释符 `--`，不是 `INSERT`，直接被判成「非法操作」。加编码字段那次踩过：
往 `sys_data_rule` 那条 INSERT 前面插了三行说明注释，`pnpm --filter api test:db`
（E2E 和 pytest 共用的建库脚本）当场报错。**种子 SQL 文件里不要写解释性的独立
注释块**，说明放 CLAUDE.md 里就够。

顺带修了一个吞错误的坑：`reset_test_db.py` 原来 `except Exception` 接不住
`execute_sql_scripts` 抛出的 `cappa.Exit`（它继承的是 `SystemExit`，不是
`Exception`），而 `cappa.Exit` 的 message 不会传给 `SystemExit` 的 args——
裸跑时 Python 默认异常处理只看得到 int 退出码，表现是「`exit 1`，一个字都不
打印」。上面这条种子 SQL 的 bug 就是靠专门 `except cappa.Exit as e: print(e.message)`
才挖出来的。

### 🔴 环境准备要「无条件写」，因为读到的可能是缓存

`global-setup.ts` 关验证码那一步原来是「先读、已经是 `false` 就跳过」。
而 `config_service.get_all()` 挂着 `@cached`（本地 + Redis 两级，TTL 2 小时，
e2e 用 Redis db 2）—— 那个读**读的是缓存**。

`pnpm --filter api test:db` 重建的是 SQL 库，**不碰 Redis**：种子把
`LOGIN_CAPTCHA_ENABLED` 打回 `'true'`，缓存里却还留着上一轮 e2e 写下的 `'false'`。
于是环境准备读到 `'false'`、判定「已经关了」、跳过写入 —— **库里那条从头到尾
没被改过**。

失败是延迟且随机的：缓存没过期时登录照常，缓存一过期真值 `'true'` 生效，
此后每一条走**真实登录表单**的用例（`login.spec.ts` / `session-tabs.spec.ts`）
当场红，报的是「点了登录还停在 `/sign-in`」，跟验证码八竿子打不着。
实测踩到过一次，两条红。

现在改成**无条件 PUT 一次 + 回读断言**（写入接口带 `@cache_invalidate`，
一次 PUT 就能把库和缓存一起摆正）。一般结论：**环境准备里的「已经是目标状态就
跳过」这种优化，只有在读的那条路径没有缓存时才成立。**

### 🔴 按全局快捷键之前要先等外壳挂上来

`page.goto()` 只等到 `load`，而 `?` / `⌘K` 的监听是 `CommandMenu` 的 effect
注册的。React 还没提交时按下去，那一次按键**谁也收不到**。

症状会骗人：**单跑那个文件永远绿**（vite 已经热了、机器也不忙），只有整套跑
（54 条、3 分钟）才偶发红，看着像「快捷键坏了」而不像时序问题。
`command-palette.spec.ts` 第二条踩过。

等一个外壳里的元素可见即可（`command-trigger` 和 `CommandMenu` 是
`_auth.tsx` 里的兄弟节点，它可见就说明那次提交已经发生）。
同一条适用于任何「不点元素、直接发全局事件」的用例。

### 造前置数据不用走 UI

`fixtures/base.ts` 的 `api` fixture 直接打接口（用 `/auth/login/swagger` 拿 token），
测「删除」「折叠状态」这类场景时，前置的「先建一个部门」不用真的点几次表单——
测试要验证的是**那一步**，不是把所有路径都走一遍 UI。`dept-crud.spec.ts` 第二条、
`tabs.spec.ts` 都是这么造数据的。

### 🔴 不要用 `waitForLoadState('networkidle')` —— 它永远不会触发

这个应用有**常驻 socket.io 连接**（在线用户靠它维护 `fba:token_online`），
所以「网络空闲」这个条件在这里不成立：`networkidle` 会一直挂到 30 秒超时，
报的还是下一行的 `locator.innerText: Test timeout exceeded` ——
看起来像元素找不到，其实是等待条件本身错了。实测踩过。

等具体的东西，不要等「网络安静下来」：

```ts
await expect(page.locator('[data-visible="true"] table tbody tr').first()).toBeVisible()
```

（顺带：`[data-visible="true"]` 前缀是必须的，理由见根 `CLAUDE.md` 硬纪律 5。）

### 数据权限：整批账号建在 `beforeAll`，且**前后端两套测试各看各的**

`data-permission.spec.ts` 是目前最大的一条（29 条用例 / 19 个账号）。
后端有一份同名矩阵（`apps/api/backend/app/admin/tests/api_v1/test_data_permission.py`），
两边**不是复制关系**，分工写在两个文件的头注释里：

| | pytest | E2E |
|---|---|---|
| 断言 | `GET /sys/depts` 的**编码集合** | 部门页**渲染出来的行** |
| 只有它能看见 | WHERE 条件的每种表达式/组合 | 树被过滤后**塌成什么形状**、空态长什么样、界面上那三条语义告警在不在、配完之后到底生不生效 |

前端这份存在的理由很具体：数据权限最容易出的不是「算错」而是「配错」，
而「配错了看不出来」只能由界面兜住 —— `rule-mixed-warn`（一条 OR 抬掉全部 AND）、
`scope-inert`（角色关了过滤开关，绑了也白绑）、`scope-disabled`（范围停用）
这三条提示是替人看的那一层，**它们本身必须有测试**，否则哪天被误删也没人知道。

三条踩出来的：

- 🔴 **`sys_role.name` 只有 `UniversalStr(32)`。** 拼名字时前缀留短一点 ——
  超了 SQL Server 报的是 `String or binary data would be truncated`，
  一句不说是哪张表哪一列的 500。实测踩过（`E2E角色-DPE_XXXXXXXXXXXX-UNFILTERED` = 34 字符）
- 🔴 **测试角色必须绑「部门管理」那几个菜单。** `/system/dept` 的守卫是
  `requirePerm('sys:dept:add')`，权限码来自角色菜单。不绑的话每个账号打开部门页
  都被重定向到 `/403`，而断言「看不到任何部门」照样**通过** —— 它压根没进那一页。
  菜单 id 按 `path`/`perms` 现查，不要硬编码种子里的雪花 ID
- 🔴 **断言顺序：先断言「应该看见的」，再断言「不该看见的」。** 反过来就是假绿 ——
  骨架屏阶段所有行都不存在，`toHaveCount(0)` 立刻通过，等于在页面加载完之前
  就判它「过滤生效了」。正向断言自带重试，它一过才说明数据已经渲染完

前置数据（19 账号 + 20 角色 + 19 范围 + 17 规则 + 6 部门）整批建在 `beforeAll`，
每条测试重建一遍要 20 秒以上。代价是那个 describe 必须
`test.describe.configure({ mode: "serial" })` —— 并行 worker 会各跑一次 `beforeAll`，
撞上编码/角色名/用户名的唯一约束。`afterAll` 按「用户 → 角色/范围/规则 → 子部门 → 父部门」
的顺序拆干净（用户挡着部门删不掉，子部门挡着父部门删不掉）。

`fixtures/base.ts` 为此多了两个导出：`createApiClient()`（脱离 fixture 生命周期，
`beforeAll`/`afterAll` 里能用）和 `loginPageAs(page, username, password)`
（`authedPage` 写死了 admin，而这份测试要的正是「换个账号看见的不一样」）。

### 🔴 跨文件并行会污染默认分页假设——`serial` 只护得住同一个 describe

`data-permission.spec.ts` 的 `beforeAll`/`afterAll` 之间会有 19 个临时账号常驻
`fba_test`（见上一节）。`test.describe.configure({ mode: "serial" })` 只保证
**这个 describe 内部**的用例不并行、不撞唯一约束——**挡不住别的 spec 文件**
在同一个时间窗口被分到另一个 worker 并行跑（`playwright.config.ts` 是
`fullyParallel: true`），而两者共用同一个 `fba_test`。

`list-error.spec.ts` 原来断言「502 重试后表里能看到 `admin@example.com`」，
默认没有筛选、看的是第一页。这个断言隐含了「用户总数不多，admin 一定在
第一页」——本地单独跑这一个文件时成立，但在 CI 上和 `data-permission.spec.ts`
撞到同一个并行窗口就会破：总数从种子的 10 涨到 29，admin 被挤到第二页，
断言失败，而失败信息看起来和这条测试本身毫无关系（一串陌生的
`dp_d_xxx@e2e.example.com` 账号）。**实测复现**：2026-08-25 给 `main` 上线分支
保护、E2E 第一次被设成必过的 required check 时当场撞见。

修法是断言改成不依赖总数/分页/具体某个用户——`table.locator('[data-slot=
"table-body"] [data-slot="table-row"]').first()` 只要表体真的渲出行就算数。
**教训**：任何断言默认视图（不筛选、不指定页）里「某条具体数据看不看得见」的写法，
在共享数据库 + 全并行的 E2E 里都是定时炸弹——数据会被同一时间窗口里跑的
别的 spec 文件影响，且它们之间没有任何协作关系。

### 现在测了什么 / 没测什么

种子用例：登录（表单校验 + 验证码关闭路径）、部门 CRUD 闭环（含 409 冲突
可见、编辑禁改编码、删除二次确认、同级重名 vs 跨级同名的回归）、多页签保活
（折叠状态 + `data-visible` 属性）、任务调度闭环。

`command-palette.spec.ts`：⌘K 呼出 → 搜页面 → 回车跳过去（顺带断言跳完标签条上多了一个 tab），
以及 `?` 的那条回归 —— **焦点在输入框里时 `?` 只能是一个字符**，不能触发帮助面板。
条目 testid 里带雪花 ID（`command-palette-item-page:2049…`），所以一律按可见文本定位，
别把种子数据的 ID 写进断言。

**`list-error.spec.ts` / `new-version.spec.ts`：两条靠 `page.route` 造假响应的测试**，这里是刻意破例。
上面那条「不 mock、打真实接口」的原则挡不住这一类 bug —— 要验的正是
「接口 502 时页面显示的是错误块还是『暂无数据』」，而真实接口不会按需 502。
两种写法（接了 `error` / 没接）在接口正常时**渲染结果完全相同**，所以不造失败就等于没测。

```ts
await page.route(/\/api\/v1\/sys\/users\?/, (route) => route.fulfill({ status: 502, … }))
```

⚠️ 拦截**只拦那一个列表端点**（正则带 `?`），别拦成 `**/sys/**` —— 用户页的
筛选栏还要拉部门树和角色列表，一起打挂就分不清错误块是哪个查询触发的。
放行改用 `route.fallback()`（试重试按钮时要让第二次请求真的打到后端）。

`new-version.spec.ts` 同理：「服务端发新版了」这件事在一条测试里没法真的发生，
只能给 `/version.json` 换一个 `buildId`。它还顺带验了一条**真实的开发期行为** ——
开发服务器上根本没有 `version.json`（那是构建产物），拿不到**不能**被当成发新版，
所以第二条断言是「不弹提示」。

加上 **`data-permission.spec.ts`（29 条 / 19 个账号）**——见上一节。

**没有**做视觉回归、没有覆盖其余列表页的筛选组合——那些页面共用同一套模板，
测一次模板 + 抽样几页就够，不是每页都要单独写一条。
