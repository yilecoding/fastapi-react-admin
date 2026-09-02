# CLAUDE.md

**fastapi-react-admin** —— 中后台底座。产品标识集中在 `apps/web/src/lib/brand.ts`
（改名字、改版本只动那一处）。

后端 fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA）
并新增 SQL Server 支持（现在同时支持 MySQL / PostgreSQL / SQL Server 三种数据库，
前两种沿用上游、SQL Server 是本仓库加的那一种）；三层结构、插件机制、RBAC 与
数据权限模型都是 FBA 的设计，归属细节见下面「fork 管理」一节。
前端基于 React 19 + TanStack Router/Query/Table v9 + shadcn（Base UI 底座）。

架构的承重方式是榫卯：`i18n ← ui ← platform ← web` 严格单向，每层只暴露形状
（组件 / 契约 / 页面），不靠胶水互相粘。登录页那枚咬合标记（`TenonMark`）
表示的就是这个，不是项目名。

同一枚榫卯套进纯色圆形徽章，就是浏览器标签页 / 桌面端窗口与安装包用的那个 logo ——
`TenonMark` 本身留给有主题背景的场合（侧边栏、登录页）继续用 `currentColor` 裸跑。
两者是同一份图形的两种呈现，唯一真相源是 `scripts/gen-brand-icons.mjs`；
改了图形或配色，跑 `pnpm brand:icons` 重新生成 favicon 与桌面图标，不要手改生成产物。

**这份文档是踩坑记录与硬纪律的唯一一份。** 全是实测出来的结论，
不是风格偏好 —— 违反了会坏，而且多数是**静默**地坏。

## 按任务导航

**这份根文件只放跨模块的东西**（结构 · 起服务 · 硬纪律）。模块级的踩坑记录
拆进了各自目录的 `AGENTS.md` —— Claude Code 读到那个目录下的文件时会**自动**
把它加载进上下文，不用你手动指。人要查的话按下表直接翻：

| 我要… | 读 |
|---|---|
| **第一次上手** | 本文件的「结构」·「本地起服务」·「硬纪律」（必读） |
| 加列表页 / CRUD 页 · 主从页 · 监控页 | [`packages/platform/src/pages/AGENTS.md`](packages/platform/src/pages/AGENTS.md) |
| 加设置屏 —— 骨架本身 / 参数配置那种 | [`_shared` 分册](packages/platform/src/pages/_shared/AGENTS.md) / [`config` 分册](packages/platform/src/pages/config/AGENTS.md) |
| 动多页签 / 标签条 / 偏好设置 / 侧边栏 | [`packages/platform/src/shell/AGENTS.md`](packages/platform/src/shell/AGENTS.md) |
| 动文件上传 / 预览 / 附件 | [`packages/platform/src/pages/file/AGENTS.md`](packages/platform/src/pages/file/AGENTS.md) |
| 动消息通知 / 铃铛 / 收件箱 | [`packages/platform/src/pages/notification/AGENTS.md`](packages/platform/src/pages/notification/AGENTS.md) |
| 动查询区 / 筛选条件 | [`packages/ui/src/components/query-bar/AGENTS.md`](packages/ui/src/components/query-bar/AGENTS.md) |
| 动富文本 / 正文里的图片 | [`packages/ui/src/components/rich-text/AGENTS.md`](packages/ui/src/components/rich-text/AGENTS.md) |
| 挑组件 / 改尺寸覆盖不生效 | [`packages/ui/AGENTS.md`](packages/ui/AGENTS.md) |
| 加文案 / 动多语言 | [`packages/i18n/AGENTS.md`](packages/i18n/AGENTS.md) |
| **显示时间 / 动时区** | [`packages/i18n/AGENTS.md`](packages/i18n/AGENTS.md) 的「服务端时间一律过 `src/datetime.ts`」 |
| **动请求客户端 / 后端契约 / 错误判定** | [`packages/api/AGENTS.md`](packages/api/AGENTS.md) |
| 动后端模型 / 接口 / SQL | [`apps/api/AGENTS.md`](apps/api/AGENTS.md) |
| 跑 pytest / 建测试库 / 测试跑不起来 | [`apps/api/backend/tests/AGENTS.md`](apps/api/backend/tests/AGENTS.md) |
| **动权限码 / 数据范围（行级过滤）** | [`apps/api/backend/common/security/AGENTS.md`](apps/api/backend/common/security/AGENTS.md) |
| **动数据库结构 / 写迁移 / 改种子数据** | [`apps/api/backend/alembic/AGENTS.md`](apps/api/backend/alembic/AGENTS.md) |
| 动定时任务 / Celery / 调度 | [`apps/api/backend/app/task/AGENTS.md`](apps/api/backend/app/task/AGENTS.md) |
| 动命令面板 / 快捷键 | [`packages/platform/src/shell/AGENTS.md`](packages/platform/src/shell/AGENTS.md) |
| 动构建注入 / 发版提示 / 错误页 | [`apps/web/AGENTS.md`](apps/web/AGENTS.md) |
| **桌面端打包 / 发版 / 自动更新** | [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md) |
| **移动端 App / Expo / uniwind / Metro** | [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md)（下面还按 `scripts/` · `src/app/` · `src/components/` 拆了三份） |
| 写或跑前端 E2E | [`apps/web/e2e/AGENTS.md`](apps/web/e2e/AGENTS.md) |
| 动菜单 / 权限 / 死链判定 | 硬纪律 6 + [`pages/menu/AGENTS.md`](packages/platform/src/pages/menu/AGENTS.md) |

每个目录下有一对 `AGENTS.md`（真身）+ `CLAUDE.md`（指向它的符号链接）：
Claude Code 只认 `CLAUDE.md`，其余 agent 工具认 `AGENTS.md`，一份内容两边都读得到。

**加新结论时追加到离代码最近的那一份**，不要往根文件堆 —— 根文件超过约 200 行
就开始掉注意力，而模块分册是按需加载的，写多少都不占别人的预算。
写完跑 `pnpm ctx:check`（见下）。

## 让这套文档不腐烂：`pnpm ctx:check`

这份文档全是**实测出来的结论**，而结论会过期 —— 过期的方式是**静默**的：
它照旧言之凿凿地指着一个已经不存在的文件。实测样本：这套规则第一次跑起来
就抓到「别用 command.tsx」这条 —— 那个 cmdk 组件早就删了，规则却还教了很久。

所以凡是能被机器核对的断言就让机器核对，和 `i18n:check` 同一个物种：

```bash
pnpm ctx:check          # 死引用 / 死链接 / 死脚本 / 死 testid / 行数预算
```

| 规则 | 级别 | 抓什么 |
|---|---|---|
| `dead-path` | 错误 | 反引号里的文件路径在仓库里找不到 |
| `dead-link` | 错误 | markdown 相对链接指向不存在的文件 |
| `dead-script` | 错误 | 反引号里的 pnpm 脚本没有任何 package.json 声明 |
| `dead-testid` | 错误 | 提到的 `data-testid` 源码里不存在 |
| `dead-anchor` | 错误 | 正文里的章节交叉引用指向一个全仓都不存在的章节 |
| `cross-file-anchor` | 错误 | 那一节在**别的分册**里 —— 拆分册最容易留下的债，改成相对链接 |
| `empty-scope` | 错误 | `AGENTS.md` 所在目录下没有源码（模块被搬走了） |
| `budget` | 警告 | 根文件 > 400 行 / 分册 > 500 行 —— 该拆了 |

🔴 **它在 CI 里跑**（static job 的 `ctx` 步骤）。曾经不在 —— 一个「让机器核对
断言」的脚本自己没被自动核对过，只在有人想起来时才跑。

它**不**校验文字对不对（那要人读），只校验「指向的东西还在不在」。
这一层能自动守住，剩下的才值得花人的注意力。

### 这套文档怎么自己长大

**修完一个静默失败的 bug，就在同一次改动里把结论追加到最近的那份分册。**
不是「以后有空补文档」—— 隔一天就只剩「改对了」，当时那个「为什么会
静默地错」的判断没了，而那才是这份文档唯一的价值。

判据是一句话：**违反了会坏，而且多数是静默地坏。** 风格偏好、
能从代码直接读出来的事实、一次性的调试过程，都不写。

写的时候用 `/ctx` 技能（`.claude/skills/ctx/SKILL.md`），它管三件事：
挑分册 · 按这里的文体写（症状 / 根因 / 修法 / **实测证据** 四件套）· 收尾跑校验。

## 结构

```
apps/api/            FBA fork（Python，uv 管理）
apps/web/            业务应用；routes/ 只声明 schema/守卫，不渲染页面
apps/mobile/         移动端 App（Expo / RN），是 apps/web 的**兄弟**
packages/i18n/       多语言包：语言文件 · i18next 实例 · 校验脚本（最底层）
packages/api/ 后端契约：信封成败语义 · ApiError · 生成的 schema.d.ts（最底层）
packages/ui/         shadcn 原语，零业务
packages/platform/   平台能力：api-client · auth · shell · pages
```

依赖方向单向：**`i18n` / `api` ← `ui` ← `platform` ← `apps/web`**。
`apps/mobile` **直接依赖那两个最底层包**，不经过 `platform` —— platform 是
web 形状的（TanStack Router、react-dom、zustand、socket.io），接进 RN 包不合适。
**`ui` 永远不 import `platform`；`i18n` 不 import 任何 workspace 包**（连
`react-i18next` 都不依赖 —— 它要保持框架无关，React 绑定在 app 层注入）。

🔴 **这个箭头必须同时体现在 `package.json` 的 `dependencies` 里，不能只体现在
`vite.config.ts` 的 `resolve.alias` / `tsconfig.app.json` 的路径映射上。**
`apps/web` 曾经就漏了这一步：代码确实按箭头方向 import `@admin/platform`，
`vite.config.ts` 也确实配了 alias 让它能跑，但 `apps/web/package.json` 的
`dependencies` 里只有 `@admin/i18n` / `@admin/ui`，没有 `@admin/platform`。
pnpm 的依赖图完全看不到这层——`platform` 自己的依赖（react/zustand/
socket.io-client/`@tanstack/react-query`…）能不能装上，全靠**别人**顺带
把它们装了。这个洞被日常的整仓 `pnpm install`（本地开发、CI 的
`typecheck · build · i18n` job）**完全盖住**：不带 `--filter` 的全量安装，
不管声没声明反正都会把所有工作区包的依赖一起装上。第一个真正做 scoped
install 的是 `apps/web/Dockerfile` 那条 `pnpm install --filter web...
--filter .`（生产镜像构建，见 `docker-compose.prod.yml`）——GHCR 构建 job
第一次在干净环境里跑这条命令就当场炸了：`pnpm -r list --filter 'web...'`
只列出 `web`/`i18n`/`ui` 三个包，`platform` 完全不在裁剪范围内，`tsc -b`
一走到 `packages/platform/src` 就成片 `Cannot find module 'react'`。
**结论：新增一个 workspace 内的 alias/路径映射时，同时问一句「这个依赖关系
在 `package.json` 里写了吗」**——两处不同步，会一直是绿的，直到某个地方
第一次做 scoped install。

## 本地起服务

```bash
docker start fba_mssql fba_redis          # SQL Server :1433 / Redis :6380
pnpm dev                                  # api :8088 · web :8888 · celery worker（含内嵌 beat）
```

`apps/api` 和 `apps/worker` 都是 pnpm workspace 成员（`package.json` 里只有一个
`dev` 脚本、零 JS 依赖），所以 `turbo dev` 会同时起**三个**进程，TUI 里各一个日志窗格。
单起某一个：

```bash
pnpm --filter api dev                     # 等价于 cd apps/api && uv run python -m uvicorn ...
pnpm --filter web dev
pnpm --filter worker dev                  # celery worker -B（worker + 内嵌 beat）
```

`apps/worker` 里**没有代码**，只有那一个脚本 —— 存在的理由是让 worker 的日志有
自己的窗格。写进 `apps/api` 的 `dev` 里（`uvicorn & celery & wait`）也能跑，
但两份日志会挤在一个窗格里交替刷，而 worker 的日志很密。

🔴 **`-B`（内嵌 beat）只用于开发。** 多副本部署时每个副本都会跑一个 beat，
同一条调度被触发 N 次。生产要分开，且 beat **只起一个**：

```bash
pnpm --filter api celery:worker           # 可以多副本
pnpm --filter api celery:beat             # 只能一个
```

⚠️ 前端端口固定在 **8888**（`vite.config.ts` 的 `server.port` + `strictPort: true`）。
**换端口要同时改四处**，只改一处的失败方式都不长得像端口问题：

| 改哪里 | 漏了的表现 |
|---|---|
| `apps/web/vite.config.ts` | —— |
| `backend/core/conf.py: CORS_ALLOWED_ORIGINS` | 页面能开，但**所有接口 CORS 失败** |
| `backend/plugin/oauth2/plugin.toml` 的两条 `OAUTH2_FRONTEND_*_REDIRECT_URI` | 第三方授权成功后**回跳到空端口** |
| `apps/desktop/scripts/dev.mjs` 的 `DEV_SERVER_URL` 默认值 | `pnpm desktop:dev` 在一个不存在的端口上等满 **60 秒**，然后打印「先跑 `pnpm --filter web dev`」—— 而它正在跑 |

🔴 **第四行是补上去的，因为它真的漂走过。** 端口从 1125 改成 8888 时这张表只写了
三处，桌面端那个默认值被漏下 —— 于是 `pnpm desktop:dev` 一直等在 `localhost:1125`
上，而超时提示指向一个**已经满足**的前提。改端口时最容易漏的就是「不在这张表里
的那一处」，所以发现新的就往表里加，别只改代码。

`strictPort: true` 是刻意的：不写它 Vite 会在端口被占时自己 +1 漂到 8889，
而上面那三处都是写死的 —— 宁可起不来，也不要「起来了但接口全挂」。

账号 `admin` / `123456`。登录要过验证码，验证码答案在 Redis：
`docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"`。

后端契约改动后跑 `pnpm --filter @admin/api gen:api` 重新生成 `schema.d.ts`。

🔴 **`pnpm install:all` 会顺带装好本地 pre-commit 钩子，换机器 / 新克隆不用再手动补一步。**
`apps/api/.pre-commit-config.yaml` 早就在（ruff `--fix --unsafe-fixes` + ruff-format + json/yaml/toml
检查 + uv-lock/uv-export），`prek` 也是 `lint` 依赖组、`uv sync` 就带上——但光有配置和
二进制不等于钩子被激活，`.git/hooks/` 不进版本库，得显式 `install` 一次：

```bash
pnpm hooks:install       # = apps/api/.venv/bin/prek install -C apps/api -f
```

❌ **不要在仓库根裸跑 `prek install`（不带 `-C apps/api`）**——`.git` 在根目录、
配置在 `apps/api/` 下，prek 把 cwd 固化进装的时候生成的 shim 里，不会自己向下
搜子目录找配置。裸装**看似成功**，但下一次真正 `git commit` 才报「找不到配置文件」
并挡住提交——静默/延迟失败，且装错了没法从 git diff 里看出来。

实测（造一个带未用 `import os` + `if x: return x else: return None` 的坏 `.py` 文件验证）：

| 装法 | 提交时的表现 |
|---|---|
| 裸 `prek install` | `No .pre-commit-config.yaml found...`，钩子形同虚设 |
| `prek install -C apps/api -f`（= `pnpm hooks:install`） | 正确进 workspace：`ruff check` 自动修了 unused-import + superfluous-else-return，`ruff format` 重新格式化；剩下 2 个缺类型标注的错误改不了，提交被挡住（exit 1） |

---

## 硬纪律（违反会坏，不是风格问题）

### 1. 平台页面组件必须 router-独立

`params` / `search` **只能走 props**，页面内部不得调用
`Route.useSearch()` / `Route.useParams()` / `useNavigate()`。

> 原因：多页签用 `<Activity>` 同时挂载所有已打开的 tab，
> 但 router 只有一个 location 是「匹配」的 —— 隐藏 tab 拿不到 match 上下文。
> 需要改 search 时用 `TabOutlet` 注入的 `onSearchChange`。

```tsx
// ✅ packages/platform/src/pages/xxx/index.tsx
export function XxxPage({ search = {}, onSearchChange }: {
  search?: XxxSearch
  onSearchChange?: (n: XxxSearch) => void
}) { … }

// ❌ 页面内部读路由
const search = Route.useSearch()
```

### 2. 视图状态必须进 URL

筛选、分页、选中项都写进 `validateSearch` 定义的 search params。

> `<Activity>` 保活只在**会话内**有效，刷新页面全丢；
> search params 才是跨刷新的持久层。两者互补，缺一不可。

### 3. 路由文件不渲染页面

`apps/web/src/routes/**` 只声明 `validateSearch` / `staticData` / `beforeLoad` 守卫，
`component: () => null`。页面由 `TabOutlet` 按 `lib/page-registry.tsx` 挂载。

### 4. TabOutlet 不能与 `<Outlet />` 共存

若活动页走 Outlet、隐藏页走 Activity，切换时活动页仍会卸载丢状态。

### 5. 隐藏 tab 的 DOM 仍在文档树里

任何 `document.querySelector` / 全局 DOM 测量 / 第三方库的全局选择器
都会命中隐藏页 —— 必须限定在 `[data-visible="true"]` 内。

> ⚠️ 但 `[data-visible="true"]` **不是瞬时唯一的**。切 tab 时有一段窗口
> 两个 frame 都是 `true`（实测：应用内切 tab ~18ms，整页加载后 ~300ms，
> 因为 `activeKey` 是从 sessionStorage 恢复的、要等 `useSyncTabs` 的 effect 纠正，
> 而 React 对隐藏的 `<Activity>` 子树是降优先级提交的）。
>
> 结论：要精确锁某个页面就按 **routeId** 锁 —— `[data-tab="/_auth/monitor/server"]`，
> 与调度时序无关。写 E2E 时尤其要注意，`[data-visible="true"] [data-testid="page-title"]`
> 会 strict-mode 撞两个元素。

### 6. 所有 ID 都是 string，永远不要 `Number()` 它

雪花 ID 约 2^61，超出 JS 的 `Number.MAX_SAFE_INTEGER`（2^53-1）。
后端在 `backend/utils/serializers.py: stringify_unsafe_ints` 里统一转成字符串下发。

> 实测：`2049629108245233664` 当数字解析会变成 `2049629108245233700`，
> 且连续 6 个菜单 ID 会塌缩成同一个值 —— 回传做更新/删除会命中错误记录。

**路由层也会犯这个错**：TanStack Router 默认对 search 值跑 `JSON.parse`，
`?role=2202097973238829056` 会变成 `2202097973238829000`，静默指向另一条记录
（实测：权限矩阵保存写到了列表第一个角色上）。已在
`apps/web/src/lib/search-params.ts` 里拦住 —— 超安全整数范围的纯整数保持字符串。
**新增携带雪花 ID 的 search 参数前，先确认这个自定义解析还接在 `router.ts` 上。**

### 7. 新增 workspace 包必须同步 Tailwind `@source`

`packages/ui/src/styles/globals.css` 里的 `@source` 决定哪些文件被扫描。
漏了的包，它独有的类会**静默不生成**（class 在、CSS 规则不在，表现为布局莫名其妙塌掉）。

⚠️ **新开一个 CSS 入口时同样要写 `@source`** —— Tailwind v4 的自动探测以那个 CSS
文件所在目录为根。`apps/mobile` 就为此全裸过一轮：入口在 `src/styles/` 下、
那目录没有组件，**一条工具类都没生成**，而打包和 Metro 全程不报错。
判据见 [mobile 分册](apps/mobile/AGENTS.md)。

### 8. 侧边栏同一层级必须用同一套组件

`SidebarMenuButton`（顶层）和 `SidebarMenuSubButton`（子层）内边距不同。
同层里给「有子项的」用前者、「无子项的」用后者，必然缩进错位。
`NavItem` 按 `nested` 参数选组件族，递归时往下传，**不要靠 `ps-*` 手动补齐**。

### 9. 请求失败必须是可见状态，不是缺失状态

`catch {}` 里把 UI 元素隐藏掉，等于把服务端错误伪装成「这个功能不存在」。
登录页验证码就踩过：限流 429 被吞掉 → 验证码字段消失 → 后端仍强制校验
→ 用户拿到一个怎么点都登不进去、还看不出原因的表单。
拉取型 UI 用 `loading | ready | off | error` 状态机：
`off` 只留给服务端明确关闭的情况，失败一律显示错误 + 重试入口。

列表页照抄一遍这三行状态位就漏了 12 次 `error` —— 现在走
`pages/_shared/list-query.ts` 的 `listState()` 把它们一次摊开，
错误块是 `ui/components/query-error.tsx` 的 `QueryError`（见 [pages 分册](packages/platform/src/pages/AGENTS.md)）。

### 10. 有限流的接口必须做单飞

React StrictMode 开发期把 effect 跑两遍。命中限流的接口（如 `/auth/captcha` 的 5次/30秒）
不去重就是配额腰斩。用 `inFlight` ref 挡住并发调用，配 `alive` ref 防卸载后 setState。

### 11. 闸门要用 `pnpm <task>` 跑，不要写 `--filter <某个包>`

CI 的 eslint job 原来是 `pnpm --filter web lint`，于是**别的包的 lint 从来没跑过**：
`packages/ui` 悄悄红了 58 条（配置和脚本都在，只是没人跑）；`packages/platform`
声明了 `"lint": "eslint"` 却既没装 eslint 也没配置，**`pnpm lint` 一路
`eslint: not found`** —— 一个写在这份文档里的脚本坏了很久，而 CI 绕过了它。

用 `turbo` 跑（`pnpm lint` / `pnpm typecheck` / `pnpm build`）就没有「漏了哪个包」
这回事：谁声明了那个 task 谁就在里面。**新增一个包的 lint/typecheck 时不用改 CI。**

### 12. 不要在仓库根裸跑 `npx tsc -b`

根目录没配 `noEmit`，会往 `src` 里吐编译产物（git 未跟踪，容易漏）。统一 `pnpm typecheck`。

### 13. `pnpm typecheck` 的结论要配 `--force` 才可信

turbo 会缓存 typecheck 的结果，而缓存命中时**打印的是上一次的日志**。
两种翻车方式都实际发生过：

- **报了一个假错**：`icon-registry.tsx` 说 `IconApi` unused，照着删掉之后
  浏览器立刻 `IconApi is not defined` —— 它在第 48 行用着，那条错是旧的
- **漏报真错**：改完 URL 参数之后 `Tasks: 5 successful`，`--force` 一跑
  才冒出来 `dashboard` 里一个未使用的变量

所以**判断「类型过了」一律 `pnpm typecheck --force`**。日常开发跑不带 force
的没问题（快），但凡要据此删代码或收工，必须 force 一遍。

---

## 数据库结构改动一律走 alembic

🔴 **改了模型就要生成迁移，没有例外。** 手写 `ALTER` / `drop_all` 重建那条路已经关了。

```bash
pnpm db:current                        # 现在在哪个版本
pnpm db:revision '加 xxx 列'            # 改完模型，生成迁移（--autogenerate）
                                       # ⚠️ 生成的文件**要读一遍再提交**
pnpm db:upgrade                        # 升到 head
pnpm db:history                        # 看链条
```

为什么改这条、三条纪律（基线刻意是空的 / `env.py` 必须 import `backend.main` /
补历史的迁移必须幂等）、以及四个守卫测试，都在
[`backend/alembic` 分册](apps/api/backend/alembic/AGENTS.md)——
**动迁移之前先读那一份**，少读一条的失败方式都是延迟且静默的。

## 还没发版 —— 可以自由重构

**0.0.1 还没发布，没有线上实例、没有要保的数据、没有外部调用方。**
所以不要为「兼容」让设计将就：

- ⚠️ **表结构改动例外 —— 从 2026-08-22 起一律走 alembic 迁移**，见下一节。
  这一条以前写的是「直接改模型、手写 ALTER 或 drop_all 重建」，已经作废
- **删字段就真删**，不要留「休眠字段」。留着的下一个人会以为它有用（`sys_menu.cache`
  就骗过一轮：字段在、界面上没有、行为不变）
- **改接口不用留旧字段**。`schema.d.ts` 是 `pnpm gen:api` 生成的，跟着后端走
- **和上游 FBA 冲突是可以接受的代价**。永久分叉是既定事实（见「fork 管理」），
  为了 cherry-pick 方便而保留用不上的结构，是把成本永久摊给自己

> ⚠️ 改模型后**表结构不会跟着变**：`--reload` 只是重启进程重新 import 模型，
> 不会去动数据库里已经建好的表。新增/删除列仍要手写 `ALTER` 或 drop_all + create_all，
> 否则新进程一样会 SELECT 不存在的列 —— reload 让人以为「已经生效了」，这是新的坑。
> 改了字段也要同步 `backend/sql/*/init_*_test_data.sql` —— 那些 INSERT 是显式列名的，
> 漏改会让全新环境初始化失败。

## fork 管理

后端 fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)
（FBA）—— 三层结构（`api/v1 → service → crud`）、插件机制、RBAC 与数据权限模型
都是它的设计，不是本仓库发明的。本仓库在此基础上新增了 SQL Server 支持，现在
同时支持 MySQL / PostgreSQL / SQL Server 三种数据库；前两种沿用上游写法，
SQL Server 是本仓库加的那一种。上游明确拒绝合并 SQL Server 支持，所以是永久分叉，
只 cherry-pick 上游安全补丁，功能更新不跟。

- 分叉基线记在 `apps/api/.upstream-baseline`
- 上游同为 MIT 协议，原始版权声明保留在 `apps/api/LICENSE`
- 后端架构文档（三层结构 / 插件机制 / RBAC 的设计意图）看上游那份最全：
  <https://docs.fba.wu-clan.cc>——本仓库的 `apps/api/AGENTS.md` 只记两件事上游文档没有的：
  和上游的差异点、以及这里踩过的实测坑
