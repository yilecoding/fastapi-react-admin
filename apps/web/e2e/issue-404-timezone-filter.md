# fastapi-react-admin · Issue #404 验证记录

日期：2026-11-20（Asia/Taipei）
Issue：https://github.com/yile2020/fastapi-react-admin/issues/404
分支 / 基线：`codex/issue-404-timezone-filters` / `5e4db70ecc8dd84058c363045d9f2e388df55e5d`（upstream/main）
Worktree：`C:\Users\yujie_ao\.codex\worktrees\issue-404-timezone-filters\fastapi-react-admin`

## 问题与修复

列表按个人显示时区渲染日志，而无时区的筛选边界由后端按服务器时区解释；日期预设和工作台“今天”下钻还使用浏览器日期。修复在查询 hook 的接口参数边界按显示时区把墙上时间换成 ISO 瞬间，并让日期预设使用显示时区日历日期。

## 静态验证

| 检查 | 结果 |
| --- | --- |
| Platform query-params、wall-time、dashboard api 单测 | 12 passed（移植到最新 main 后重跑） |
| UI datetime-picker-state 单测 | 18 passed |
| `@admin/platform`、`@admin/ui`、`web` typecheck | 通过 |
| 涉及 Platform、UI 与新 E2E 文件 ESLint | 通过 |
| `pnpm ctx:check` | 通过（移植后重跑） |
| `pnpm ui:registry --check` / `git diff --check` | 通过 |
| `pnpm arch:check` | 失败：playground-table 两处 `page-root-padding`，`apps/web/Dockerfile` 一处 `dockerfile-unparseable`；均在本次改动之外，未作基线对照 |

新增的浏览器用例位于 `tests/log-timezone-filter.spec.ts`，Playwright 可发现该用例（`--list`）。

## 浏览器回归与限制

Ego-browser v2.2.1 在修复分支的 Vite 页面 `http://127.0.0.1:1127/dashboard` 实际打开并观察到“暂时连不上服务器”。E2E 专用 `apps/api/backend/.env.e2e` 不存在，8001 端口及数据库 / Redis 端口无监听；Playwright 可发现新增用例，但完整 E2E 无法启动。因此没有运行登录日志页面回归，也没有验证真实 API 请求；列表与工作台场景仍未验收。

本轮启动在 1127 的 Vite 服务已停止；另有 8888 端口进程仍监听，未确认是否属于当前任务，因此保留。ego-browser task space 已关闭；源工作区未提交改动未动。
