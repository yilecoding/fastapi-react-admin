# 参与贡献 / Contributing

先说清楚项目的状态，省得你白花时间：

- **还在 0.x**（最新版见 [Releases](https://github.com/yilecoding/fastapi-react-admin/releases)）。
  接口可以直接改、不留旧字段，不用为兼容性让设计将就；**表结构改动一律走 alembic 迁移**（见下文「后端」）
- **后端最初基于 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) 构建，已经独立演进**：
  只 cherry-pick 上游的安全补丁，功能更新不跟。改 `apps/api/` 时不必考虑「怎么合回上游」
- **前后端都有自动化测试，且都打真实依赖不 mock**：后端 767 条 pytest 对真实数据库 + Redis，
  前端 89 条 Playwright 对真实浏览器 + 真实接口 + 真实库。改动涉及的模块**有对应测试的必须跑绿**，
  没测试覆盖到的部分才退回 `pnpm typecheck` + 手动点

## 提 issue 之前

先看这两处，能省掉大部分来回：

1. **[CLAUDE.md](./CLAUDE.md)** —— 「硬纪律」那一节。里面十几条都是踩过之后写下来的，
   带实测数据。**很多看起来像 bug 的行为是刻意设计**（比如目录型菜单的 `path`
   前端本来就没有对应路由、监控页没有历史数据、列表页一律不注册排序）
2. **[SECURITY.md](./SECURITY.md)** —— 「已知的、尚未修复的问题」那张表。
   安全问题请走私密报告，不要开公开 issue

## 本地开发

**前置**：Node ≥ 22.13 · Python ≥ 3.10 · [uv](https://docs.astral.sh/uv/) · Docker。
pnpm 版本由 `package.json` 的 `packageManager` 精确锁定（corepack 会自动装对应版本）。

```bash
# 1. 起依赖（PostgreSQL 16 + Redis）
docker compose -f docker-compose.dev.yml up -d

# 2. 装依赖（JS workspace、后端 Python 开发依赖、pre-commit 钩子、Playwright Chromium）
pnpm install:all

# 3. 配后端环境变量。模板默认值已经和上面那份 compose 对齐（postgres:5432 / redis:6380 / 雪花主键）
cp apps/api/backend/.env.example apps/api/backend/.env

# 4. 建表 + 灌种子数据 + 标记迁移版本（会先让你确认）
#    ⚠️ 它会 DROP 并重建所有表，只在首次或想重置时跑；之后表结构变化用 pnpm db:upgrade
pnpm db:init

# 5. 起服务
pnpm dev                                    # api :8088 · web :8888 · celery worker
```

账号 `admin` / `123456`。**登录默认要过图形验证码**；本地想省掉这一步，在「参数配置」里把
`LOGIN_CAPTCHA_ENABLED` 改成 `false`（改完立即生效）。要照原样输验证码，先记下
`GET /api/v1/auth/captcha` 响应里的 `uuid`，再查答案：

```bash
docker exec fba_redis redis-cli --raw GET "fba:login:captcha:<uuid>"
```

### 换数据库 / 接对象存储

可选的依赖都在同一份 `docker-compose.dev.yml` 里，按需打开，再改 `.env` 里的 `DATABASE_*`：

| 要用 | 命令 | 备注 |
|---|---|---|
| **SQL Server** | `docker compose -f docker-compose.dev.yml --profile sqlserver up -d mssql` | 宿主机还要装 [Microsoft ODBC Driver 18](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)（后端走 `aioodbc`，容器里那份驱动不算 —— 不装的表现是「库起来了、后端一连就报 `Can't open lib ... ODBC Driver 18`」） |
| **MySQL** | 自备 MySQL 8.x（compose 里没有） | `DATABASE_TYPE='mysql'`，字符集用 `utf8mb4` |
| **S3 兼容存储**（RustFS） | `docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs` | 在「存储管理」里新建存储前，`.env` 里要配 `STORAGE_ENCRYPT_SECRET_KEY`（`openssl rand -hex 32`） |

> ⚠️ `.env.example` 默认 `DATABASE_PK_MODE='snowflake'`，别改成 `autoincrement` ——
> 种子数据只提供雪花版，自增模式下初始化会**静默跳过**种子，库建好了却没有 admin 账号。

### 几个容易卡住的地方

- **两套测试都跑在独立的 `fba_test` 库上**（E2E 连的也是它，只是走另一套端口和另一个 Redis db），
  第一次要先建库：`pnpm --filter api test:db`，见 [`backend/tests/AGENTS.md`](./apps/api/backend/tests/AGENTS.md)
- 后端开了 `--reload`，改 Python 代码会自动重启。但**改模型不等于改表** ——
  表结构改动一律走 alembic，reload 只是重新 import 模型，不会去动库
- 前端端口固定在 8888（`strictPort`，被占时直接报错而不是漂到 8889）。换端口要同时改四处，详见 [CLAUDE.md](./CLAUDE.md)
- 后端契约改动后跑 `pnpm --filter @admin/api gen:api` 重新生成前端类型

## 分支模型：GitHub Flow

`main` 上有分支保护（ruleset，2026-08-25 起生效），直接 push 会被拒绝——包括仓库
owner 自己，没有旁路。流程是标准 GitHub Flow：

```
main（受保护，只能通过 PR 合入）
 └─ feat/xxx · fix/xxx · docs/xxx · chore/xxx   从 main 切出来，改完开 PR
```

- 分支名前缀对齐 commit 前缀（Conventional Commits 风格，`feat:`/`fix:`/`docs:`/`chore:`）
- 合并前必须：5 个必需检查全绿（见下；`pytest · PostgreSQL` 也会跑，但不在必需检查里）。**不要求人工 review**——单人维护，
  要求别人批准会直接把自己锁死；门槛全靠 CI
- 三种合并方式（merge / squash / rebase）都开着，没有强制线性历史，看改动大小自己选

### CI 红了会怎样 —— **不开 issue**，这是刻意的

红绿信号只在三个地方，都不用维护：

| 在哪 | 什么时候看得到 |
|---|---|
| PR 上的 checks | 提 PR 之后；红了合不进去（5 个必需检查） |
| README 顶部的 CI 徽章 | 任何时候 —— 「main 此刻是红还是绿」的常驻答案 |
| GitHub 的 Actions 失败通知 | 自己触发的 run 失败时（邮件 / 站内） |

> 🔴 **曾经有一个「CI 失败自动开 issue」的 job，已经删掉，别再加回来。**
> 它开的是**第四份**同样的信号，而它自己需要维护：那段「查找已有的失败 issue，
> 避免重复」的判据是「正文里包含 `[#<runId>]`」—— `runId` 每次运行都不一样，
> 条件**永远不可能命中**，所以每次失败都新开一条。实测：一个下午攒了 8 条
> `🔴 CI Failed`，其中 5 条是 main 上同一个问题、2 条是同一个 PR 的同一个 flake，
> 把真正的 enhancement issue 全冲下去了。
> 修去重（覆盖同一条 + 绿了自动关）也做过一版，跑通了 —— 然后连它一起删了：
> 一个要靠自己维护的机器人，去复述一个已经有三处显示的状态，不值得存在。
>
> issue 列表留给**人**写的东西（bug / enhancement），不给 bot 用。
> flake 也不例外：它会让一次 PR 的 CI 变红，重跑就过，不需要留档；
> 真的反复出现，那就是一条值得**人**去写的 bug issue。

## 发版

**每合进一个大功能打一个 tag**：大功能升次版本号（0.1.0 → 0.2.0），只有修复升修订号。
版本号的单一来源是 `apps/web/package.json` 的 `version`（`brand.ts` 和 `/version.json` 都读它，根 `package.json` 保持同值）。

```bash
# 1. 改 apps/web/package.json（和根 package.json）的 version，最好在那个大功能的 PR 里顺手改
# 2. 合进 main、CI 绿了之后，在 main 上打带说明的 tag
git tag -a v0.2.0 -m "v0.2.0 — 这一版的主要功能" && git push origin v0.2.0
```

tag 推上去之后：

| 谁 | 做什么 |
|---|---|
| `.github/workflows/release.yml` | Windows / macOS / Linux 各出一份桌面端安装包 → 传成 GitHub Release **草稿** |
| `.github/workflows/ci.yml` 的 `build-images` | 只在 **push 到 main** 时跑，推 `latest` + `sha-<短 SHA>` + `sha-<完整 SHA>` 镜像标签；**不跟 tag** |

- 🔴 **tag 和 `apps/web/package.json` 的版本不一致时 release 会直接失败**（故意的）
- 草稿 release 要人工确认后再发布：安装包能不能装、能不能连上后端，机器判不了
- 想试这条流水线又不想留 tag：Actions → Release → Run workflow，出的包只作为 artifact
- 桌面端出包 / 分发 / 自动更新的坑收在 [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)

## 提 PR 之前

这几道门必须全绿，CI 的 job 都跑（`typecheck · build · i18n` / `eslint` /
`ruff` / `pytest · SQL Server` / `pytest · PostgreSQL` / `playwright · E2E`，数据库用
GitHub Actions 的 service containers 自建，不是「本地才跑」）：

```bash
pnpm typecheck --force          # 全仓库 tsc（不带 --force 会命中 turbo 缓存，见 CLAUDE.md 硬纪律 12）
pnpm lint                       # eslint（web · ui · platform · mobile 四个包）
pnpm build                      # web + mobile + desktop —— 前端唯一的「整体还装得起来」信号
pnpm i18n:check && pnpm i18n:jsx
pnpm ctx:check                  # 工程文档里的死引用 / 死链接 / 死脚本 / 死 testid
pnpm arch:check                 # 依赖箭头：import / tsconfig paths / 方向
pnpm test                       # 后端 pytest（767 条）；要先备好 fba_test 库
pnpm e2e                        # 前端 Playwright（89 条）；自动拉起隔离的 web+api 实例
```

🔴 **用 `pnpm <task>` 跑，别写 `--filter <某个包>`**（硬纪律 13）。这里原来写的是
`pnpm --filter web build`，于是移动端和桌面端的构建都不在门里 —— 而 `packages/ui`
的 lint 也正是这么悄悄红了 58 条的。

改了前端页面/组件、后端接口/数据权限逻辑，对应的测试文件找不到就自己补一条——
这两套测试的价值就在于打真实依赖，不接受用 mock 绕过去的版本。

### 几条会让 PR 被打回的硬规则

这些不是风格偏好。完整版在 CLAUDE.md，这里只列最容易犯的：

| | |
|---|---|
| **所有 ID 都当 string** | 雪花 ID 约 2^61，超出 JS 的 `Number.MAX_SAFE_INTEGER`。`Number()` 它会让连续几个 ID 塌缩成同一个值 —— 实测过，回传做更新会命中错误记录 |
| **视图状态必须进 URL** | 筛选、分页、选中项写进 `validateSearch`。`<Activity>` 保活只在会话内有效，刷新全丢 |
| **页面组件必须 router-独立** | `params` / `search` 只能走 props，页面内不许调 `Route.useSearch()` —— 隐藏页签拿不到 match 上下文 |
| **请求失败必须是可见状态** | `catch {}` 里把 UI 隐藏掉，等于把服务端错误伪装成「这个功能不存在」 |
| **新增文案一律走 `t()`** | 中文原文即 key。两个校验脚本都要过：`i18n:check` 管 `t('…')`，`i18n:jsx` 管压根没进 `t()` 的裸中文 |
| **改了模型要同步种子 SQL** | `backend/sql/*/init_*.sql` 的 INSERT 是显式列名的，漏改会让**全新环境初始化失败** —— 这个坑真踩过 |

### 后端

三层：`api/v1/` → `service/` → `crud/`，模型在 `model/`、DTO 在 `schema/`。

SQL Server 的适配约定（用错了在本地默认的 PostgreSQL 上多半跑得通，
只在 CI 的 `pytest · SQL Server` job 上炸——本地起 PG 不会替你查这几条）：

- 存中文用 `UniversalStr(n)`，**不要** `sa.String(n)`
- 分页查询必须带 `ORDER BY`（`select_order`）—— `OFFSET FETCH` 强制要求
- 含可空列的唯一约束要改用筛选唯一索引

⚠️ **改模型不等于改表。** 表结构改动一律走 alembic（`pnpm db:revision '说明'` +
`pnpm db:upgrade`），生成的迁移文件**要读一遍再提交**——没有例外，手写 `ALTER` 或
`drop_all` 重建那条路已经关了，详见 [CLAUDE.md](./CLAUDE.md)「数据库结构改动一律走 alembic」。
测试库用 `pnpm --filter api test:db` 一键重建（内部会自动 stamp 到 head）。

### 前端

新增资源页照 `packages/platform/src/pages/user/` 抄，三件套 + 特性。
工具栏与状态展示不要自己手写，一律取 `pages/_shared/`。

依赖方向单向：**`i18n ← ui ← platform ← web`**。`ui` 永远不 import `platform`。

## 提交信息

没有强制规范。写清「改了什么、为什么」就行，中英文都可以。
如果修的是一个**踩过的坑**，请顺手把结论补进 CLAUDE.md —— 那份文档的价值全在这里。
