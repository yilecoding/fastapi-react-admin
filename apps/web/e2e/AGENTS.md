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

### 造前置数据不用走 UI

`fixtures/base.ts` 的 `api` fixture 直接打接口（用 `/auth/login/swagger` 拿 token），
测「删除」「折叠状态」这类场景时，前置的「先建一个部门」不用真的点几次表单——
测试要验证的是**那一步**，不是把所有路径都走一遍 UI。`dept-crud.spec.ts` 第二条、
`tabs.spec.ts` 都是这么造数据的。

### 现在测了什么 / 没测什么

三条种子用例：登录（表单校验 + 验证码关闭路径）、部门 CRUD 闭环（含 409 冲突
可见、编辑禁改编码、删除二次确认、同级重名 vs 跨级同名的回归）、多页签保活
（折叠状态 + `data-visible` 属性）。**没有**做视觉回归、没有覆盖其余列表页的
筛选组合——那些页面共用同一套模板，测一次模板 + 抽样几页就够，不是每页都要
单独写一条。
