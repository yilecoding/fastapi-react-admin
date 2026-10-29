# 博客系列

一篇总览，加上一篇篇只讲一个主题的短文。短文的规矩：

- 标题承诺什么，正文只讲什么，项目介绍只在文末留一句链接
- 每个坑按「现象 → 原因 → 修法 → 代码」写，结论要能在源码或测试里找到出处
- 篇幅控制在一次读完（2000 字左右）

## 这个分支怎么维护

`blog` 是一个**孤儿分支**（和 `main` 没有共同历史），只放博客，**永远不合并进 `main`**。
没有共同历史，GitHub 上也开不出往 `main` 合并的 PR，不会误合。

- 本地用一个单独的 worktree 维护，不用在主检出里来回切分支：
  ```bash
  git worktree add ../fastapi-react-admin-blog blog   # 新克隆后建一次
  ```
- 图片用本分支的 raw 地址：`https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/<文件名>`，
  `blog` 分支推送后才能访问。发掘金时直接把 `images/` 里的图拖进编辑器更稳（国内访问 raw 地址经常慢或失败）
- 文章里的源码路径、功能清单都以 **`main`** 为准，只写已经合进 `main` 的东西。
  `main` 合进大功能（例如邮件 / 短信通知渠道）后，回来更新 `00-system-overview.md` 的功能表；
  文中引用的文件改名或删除时，同步改文章

## 已写

| 文件 | 标题 | 出处 |
|---|---|---|
| `00-system-overview.md` | fastapi-react-admin 系统介绍 | README、根 `CLAUDE.md` |
| `01-react-activity-tabs.md` | 用 React 19.2 的 `<Activity>` 做多页签保活，我踩了 6 个坑 | `packages/platform/src/shell/` 分册 |
| `02-snowflake-id-precision.md` | 雪花 ID 丢精度不只在 JSON.parse：我在一个中后台里找到了 5 个出口 | 硬纪律 6、`packages/api` 分册 |

建议发布顺序：00 → 01 → 02。00 的「系列文章」一节和 01、02 的文末，发布后补上掘金链接。

## 待写（按话题性排序）

| 主题 | 一句话 | 素材在 |
|---|---|---|
| AI 助手怎么做到不越权 | 引擎手里没有可执行体，权限、确认、审计都在一个调度层 | `apps/api/backend/plugin/ai/AGENTS.md` |
| 数据权限放在 DAO 层 | ContextVar 自动带上当前用户；Celery 里没有用户 = 不过滤 | `common/security`、`common/dataio` 分册 |
| 分页查询里的多对多 join | 11 个用户报 total=12，每页还少两条 | `apps/api/backend/common/AGENTS.md` |
| 列表页把「接口挂了」显示成「暂无数据」 | 12 个页面都漏了 `error` | `packages/platform/src/pages/AGENTS.md` |
| FastAPI 返回 RedirectResponse，cookie 丢了 | 第三方登录的人从来没拿到 refresh cookie | `apps/api/AGENTS.md` |
| `X-Real-IP` 让限流形同虚设 | 每个请求换一个 IP 就是一份新配额 | `apps/api/AGENTS.md` |
| 改完再读同一个 ORM 实例 | 密码历史检查从来没生效过 | `apps/api/AGENTS.md` |
| 导出 Excel 的公式注入 | 用户名里写 `=HYPERLINK(…)`，导出文件里就是公式 | `common/dataio` 分册 |
| pnpm workspace 少写一行依赖 | 本地和 CI 一直绿，第一次 scoped install 才炸 | 根 `CLAUDE.md`「结构」 |
| turbo 缓存打印的是上一次的日志 | 照着假错删代码，浏览器当场报错 | 硬纪律 12 |
| 用 CLAUDE.md 记踩坑 | 文档只记「会静默坏」的结论，再用脚本防它腐烂 | 根 `CLAUDE.md`、`scripts` 分册 |
