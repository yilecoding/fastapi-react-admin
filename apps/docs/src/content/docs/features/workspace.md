---
title: 工作台与界面
description: 每个人自己的工作台（选卡片、拖拽排序、调宽度，按权限出现，布局存服务端跨设备同步）；命令面板 ⌘K、快捷键、功能引导；主题色 / 圆角 / 密度 / 页签外观；列表列的显隐与排序写进地址栏；每人自己的时区、中英双语、发新版提示。
sidebar:
  order: 0
---

登录后的首页是**工作台**：一组卡片（待我处理、我发起的、快速发起、常用入口、消息、公告、需要你留意、服务状态、近 14 天访问），每个人自己选显示哪些、怎么排、多宽，布局存在服务端，换台电脑登录还是自己那一套；没有权限的卡片根本不出现。工作台之外，整个界面还有几样通用的东西：⌘K 命令面板、快捷键、第一次登录时的功能引导、个人中心里的外观设置、列表的列显隐与排序、每人自己的时区和语言，以及发了新版本时的刷新提示。多页签单独写在[多页签保活](/features/multi-tab/)。

## 在界面上哪里找？

| 入口 | 在哪 | 存在哪 |
|---|---|---|
| 工作台、「自定义」按钮 | 仪表盘 `/dashboard`，所有登录用户 | 服务端，按人（跨设备） |
| 命令面板 | 任意页面按 ⌘K / Ctrl+K | —— |
| 快捷键帮助 | 按 `?`，或顶栏「帮助」 | —— |
| 功能引导 | 第一次登录自动开始；顶栏「帮助 → 功能引导」或命令面板里重看 | 浏览器本地，按人 |
| 外观与布局偏好 | 个人中心 → 主题 / 布局 / 多标签页 | 浏览器本地 |
| 显示时区 | 个人中心 → 资料 | 服务端，按人 |
| 界面语言 | 右上角用户菜单 → 界面语言；登录页也能切 | 浏览器本地 |
| 列表的「列」 | 各列表页表头右侧 | 地址栏 |

## 工作台有哪些卡片？谁看得到？

| 卡片 | 内容 | 谁看得到 | 默认 |
|---|---|---|---|
| 待我处理 | 最多 6 条，分「全部 / 待审批 / 退回给我 / 草稿」 | 侧边栏里有审批中心的人 | 2/3 宽，显示 |
| 我发起的 | 最近 3 张单子的进度条；超过 1 天没动静的可以「催办」 | 同上 | 1/3，显示 |
| 快速发起 | 4 个能发起的流程 | 同上 | 1/3，显示 |
| 常用入口 | 从自己侧边栏里挑的页面，默认 6 个、最多 12 个 | 所有人 | 1/3，显示 |
| 和我有关的消息 | 4 条未读，和铃铛同一份数据 | 所有人 | 1/3，显示 |
| 公告 | 5 条公告 | 所有人 | 整行，**默认隐藏** |
| 需要你留意 | 被自动停用的 Webhook、近 24 小时失败的任务、今天登录失败的异常增长 | 有 `open:webhook:list`、`task:scheduler:edit`、`log:login:list` 任一的人 | 一半，显示 |
| 服务状态 | API / 数据库 / 缓存 / 定时调度 / 后台任务，加三端在线会话数 | 超级管理员 | 一半，显示 |
| 近 14 天访问 | 每天登录成功 / 失败的柱状图 | `log:login:list` | 整行，显示 |

**没有权限的卡片不渲染**，而不是渲染一个「无权限」的空壳；后端取数接口按同一套条件拦。「系统运行」这一组只对能看到其中至少一张卡片的人出现。

## 怎么自定义工作台？

点右上角「**自定义**」进入编辑模式（地址栏里多一个 `edit=true`，刷新还在）：

- 每张卡片可以显示或隐藏
- 拖拽排序，也可以用键盘（空格拿起、方向键移动、空格放下）；每组各排各的
- 宽度四档：三分之一 / 一半 / 三分之二 / 整行
- 挑「常用入口」里放哪些页面
- 「恢复默认」

布局按人存在服务端（`sys_user_preference` 表，键 `dashboard.layout`），换浏览器、换电脑登录都一样。兼容规则保证布局不会因为升级坏掉：认不出的卡片忽略、新加的卡片排到最后、某个字段坏了只回落那一个字段；整份都认不出来时显示一条提醒，用默认布局。**读布局失败**时显示错误、用默认布局，并且**不许编辑**（否则一保存就把服务端那份真的布局覆盖掉了）；保存失败时错误留在编辑器里，草稿不丢。

## 命令面板和快捷键

按 **⌘K**（Windows / Linux 上是 Ctrl+K）打开命令面板，能搜三类东西：

- **已打开的标签页**
- **页面**：自己侧边栏里有的页面（已经开着的不重复列），外链也在里面
- **操作**：重新加载当前页、关闭其它标签页、关闭全部标签页、快捷键、功能引导；当下做不了的操作不列出来

按顺序匹配（输入的字按顺序出现在名称、路径或说明里就算命中），名称匹配排在前面。命令面板**不搜业务数据**，也没有「最近使用」。

快捷键：

| 键 | 作用 |
|---|---|
| ⌘K / Ctrl+K | 打开命令面板 |
| ⌘B / Ctrl+B | 折叠 / 展开侧边栏 |
| `?` | 快捷键帮助（在输入框里打问号不会触发） |
| ↑ ↓ · Enter · Esc | 命令面板里选择、打开、关闭 |
| 鼠标中键点页签 | 关闭页签（可以在偏好里关掉） |
| 右键点页签 | 页签菜单 |

## 功能引导是什么？

第一次进工作台时自动开始的一段七步引导：侧边栏 → 多页签 → 页面内容 → 命令面板 → 通知中心 → 个人中心 → 帮助。登录后有公告弹窗的话，等弹窗关了才开始。想再看一遍，在顶栏「帮助 → 功能引导」或命令面板里点。关掉了多页签的人，引导自动跳过那一步。

「看过了」记在**浏览器本地**（按用户、按引导版本），所以换一台电脑登录会再出现一次。

## 外观能调哪些？

在「个人中心」的主题、布局、多标签页几栏里，改了立即生效，没有保存按钮：

| 项 | 默认 | 可选 |
|---|---|---|
| 主题模式 | 浅色 | 浅色 / 深色 / 系统 |
| 主题色 | 靛蓝 | 7 种 |
| 圆角大小 | 柔和 | 6 档 |
| 界面密度 | 标准 | 5 档（控件高 24–36 px） |
| 滚动方式 | 内容区域 | 内容区域（顶栏和页签条不动）/ 整页 |
| 显示多标签页 | 开 | |
| 标签页外观 | 卡片 | 按钮 / 卡片 / 柔和 / 下划线 |
| 显示标签页图标 · 中键关闭 · 拖拽排序 | 开 | |

这些存在**浏览器本地**（`localStorage` 的 `admin:prefs`），不跟着账号走：换浏览器要重新设。「恢复默认」会把这些全部还原（已看过的引导不受影响）。登录页也跟随主题，并且有自己的主题和语言切换。

## 列表页的列、分页和筛选

- **列**：表头右侧的「列」按钮里勾选显示哪些列、拖动调整顺序。设置写进地址栏（`hide=` 是隐藏的列，`cols=` 是和默认不同的顺序），所以刷新还在、发链接给别人也是同样的列；「恢复默认」清掉这两个参数。
- **分页**：每页 10 / 20 / 30 / 50 条，默认 20；改过之后才写进地址栏。
- **查询区**：回车查询；条件改了还没查时有一行提示「条件已改，按回车应用」，查询前先校验；可以添加条件、折叠。条件写进地址栏，「重置」清掉。**筛选视图**（把一组条件存起来）只存在浏览器本地，界面上写明了这一点。

## 时区和语言

- **时区**每人一个，在「个人中心 → 资料」里设，默认 `Asia/Shanghai`。它**只影响界面上的时间怎么显示**（列表、详情、工作台的问候与「今天」的边界、导出文件里的时间），不影响日志记录的时刻、也不影响定时任务按哪个时区跑。改完之后，已经打开的页签要刷新一下数据才会换算。
- **语言**有简体中文和 English，在右上角用户菜单或登录页切换，存在浏览器本地；切换后发给后端的请求带上 `Accept-Language`，后端的提示信息、参数配置名、接口说明等跟着换语言。用户自己录入的业务数据不翻译。

## 发了新版本，正在用的人怎么知道？

前端每 10 分钟、以及每次切回这个浏览器标签（最多每分钟一次）去取一次 `/version.json`，和自己打包时的版本号比；也会捕获「加载页面代码失败」这种发版后才会出现的错误。发现新版本时弹一条不会自动消失的提示「已发布新版本」，带「刷新」按钮。**不会自己刷新** —— 用户可能正填着表单。

## 给工作台加一张卡片

1. 在 [`dashboard/cards/registry.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/dashboard/cards/registry.ts) 加一项：`id`、所在分组、标题、`available`（谁看得到）、默认宽度、默认是否显示。
2. 在 `cards/` 下写组件，外面套 `DashboardCard`。
3. **`available` 的判断要和取数接口的权限检查一致**，一张卡片一个接口 —— 否则会出现「卡片显示了、接口 403」。
4. 两份语言包加文案。
5. **卡片的 `id` 永远不要改**：用户存的布局按它认卡片，改了就等于删掉一张、加了一张新的。

**命令面板加一个操作**：往 [`shell/command-menu.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/command-menu.tsx) 的 `actionItems` 里加；新页面只要有菜单行就会自动出现。**加快捷键**没有注册表：自己挂监听，组合键要 `preventDefault`，单键要先判断是不是在输入框里，再到 `shortcuts-dialog.tsx` 里加一行说明。**加一步功能引导**：在 `shell/tour/shell-tour.ts` 里加步骤、给目标元素加 `data-tour`（目标不存在时 `pnpm arch:check` 会报错），想让看过的人再看一次就把版本号加一。

## 它不做什么

- 外观偏好、语言、筛选视图、「引导看过了」都只存在当前浏览器，不跟账号同步；只有工作台布局和时区存在服务端。
- 只有外壳这一套功能引导，还没有按页面的引导。
- 命令面板不支持拼音首字母搜索。
- 改了时区，已打开的页签不会自动换算，要刷新数据。
- 查询区里「今天」这类快捷时间按浏览器本地时间算，工作台的「今天」按显示时区算；两者不同时，从工作台跳过去的明细可能差一天（从代码推断，没有测试覆盖）。

## 代码在哪

- 工作台：[`pages/dashboard/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/dashboard)（`layout.ts` 兼容规则、`editor.tsx` 编辑模式、`cards/`）· 偏好接口 [`api/v1/sys/user.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/api/v1/sys/user.py) 的 `/me/preferences/{key}` · 规矩见 [`dashboard/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/dashboard/AGENTS.md)
- 外壳：[`shell/command-menu.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/command-menu.tsx) · [`shell/hotkeys.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/hotkeys.ts) · [`shell/tour/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/shell/tour) · [`shell/preferences.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/preferences.ts)
- 列表：[`_shared/use-column-visibility.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/_shared/use-column-visibility.ts) · [`_shared/use-column-order.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/_shared/use-column-order.ts) · 查询区 [`ui/components/query-bar/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/ui/src/components/query-bar)
- 时间显示：[`i18n/src/datetime.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/i18n/src/datetime.ts) · 发版提示 [`apps/web/src/lib/app-version.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/src/lib/app-version.ts)

## 怎么测的

- 单元测试（Vitest）：[`dashboard/layout.test.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/dashboard/layout.test.ts)（17 条：新卡片排到最后、整份认不出来时回落默认并标出来……）、`card-rules.test.ts`、查询区的 `params.test.ts`（38 条）。
- 后端：[`test_user_preference.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/api_v1/test_user_preference.py)（没存过的键读出来是 null 而不是 404、只能读写自己的）、`test_dashboard_ops.py`（访问统计按看的人的时区切天）。
- 浏览器端（Playwright）：[`dashboard-personalize.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/dashboard-personalize.spec.ts)（10 条，含第二个浏览器登录同一个人看到同样的布局、读布局失败时显示错误且不能编辑）、[`command-palette.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/command-palette.spec.ts)（`?` 打开快捷键帮助，但在输入框里打问号不弹）、[`tour.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/tour.spec.ts)、[`new-version.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/new-version.spec.ts)、[`query-bar.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/query-bar.spec.ts)。
- 没有 E2E 的：外观偏好、切换时区、列显隐。

## 在演示站里试试

[在线演示](https://fra.wubunan.com/sign-in)（`admin` / `123456`）：在工作台点「自定义」，把「公告」打开、拖到最前面、改成一半宽，保存；再开一个无痕窗口登录，看到的是同一套布局。按 ⌘K 输入「用户」直接跳到用户管理；按 `?` 看全部快捷键。演示站所有人共用 `admin`，工作台布局也是共用的，试完点「恢复默认」。
