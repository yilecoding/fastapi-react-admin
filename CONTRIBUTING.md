# 参与贡献 / Contributing

先说清楚项目的状态，省得你白花时间：

- **0.0.1，没有发过版**，也没有线上实例。所以**表结构可以直接改模型**，接口可以直接改，
  不用为兼容性让设计将就（详见 [CLAUDE.md](./CLAUDE.md) 的「还没发版 —— 可以自由重构」）
- **后端是 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) 的永久分叉**。
  上游明确拒绝合并 SQL Server 支持，所以我们只 cherry-pick 上游安全补丁，功能更新不跟。
  改 `apps/api/` 时不必考虑「怎么合回上游」
- **前后端都有自动化测试，且都打真实依赖不 mock**：后端 194 条 pytest 对真实 SQL Server，
  前端 44 条 Playwright 对真实浏览器 + 真实接口 + 真实库。改动涉及的模块**有对应测试的必须跑绿**，
  没测试覆盖到的部分才退回 `pnpm typecheck` + 手动点

## 提 issue 之前

先看这两处，能省掉大部分来回：

1. **[CLAUDE.md](./CLAUDE.md)** —— 「硬纪律」那一节。里面十几条都是踩过之后写下来的，
   带实测数据。**很多看起来像 bug 的行为是刻意设计**（比如目录型菜单的 `path`
   前端本来就没有对应路由、监控页没有历史数据、列表页一律不注册排序）
2. **[SECURITY.md](./SECURITY.md)** —— 「已知的、尚未修复的问题」那张表。
   安全问题请走私密报告，不要开公开 issue

## 提 PR 之前

这几道门必须全绿（CI 跑前三道；pytest / e2e 都要真实 SQL Server，本地跑，不在 CI 里）：

```bash
pnpm typecheck                 # 全仓库 tsc（结论要 --force 才可信，见 CLAUDE.md 硬纪律 12）
pnpm --filter web build         # 前端唯一的「整体还装得起来」信号
pnpm i18n:check && pnpm i18n:jsx
pnpm test                       # 后端 pytest（194 条）；要先备好 fba_test 库
pnpm e2e                        # 前端 Playwright（44 条）；自动拉起隔离的 web+api 实例
```

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

SQL Server 的适配约定（用错了在 PostgreSQL 上跑得通、在主线数据库上炸）：

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
