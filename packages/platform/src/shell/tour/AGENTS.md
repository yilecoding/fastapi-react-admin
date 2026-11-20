# platform/shell/tour —— 功能引导（driver.js）

> 这份文件是 [`shell` 分册](../AGENTS.md) 的**子分册**（2026-11-20 从那份里拆出来：那份到了 500 行预算），
> Claude Code 读到本目录下的文件时才把它加载进上下文。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。


选型与被排除的库（Shepherd / Intro.js 是 AGPL）见 issue #98。这里只记接进这个外壳时
会**静默**坏的东西。

| 文件 | 职责 |
|---|---|
| `tour/targets.ts` | 目标解析：`inShell(id)` · `inTab(tabKey, id)` · `tabFrame(tabKey)`，**只暴露函数**，写不了裸选择器 |
| `tour/tour.ts` | `startTour(def)` · `resolveSteps()`；**唯一**允许 import `driver.js` 的地方 |
| `tour/shell-tour.ts` | 外壳导览七步（侧边栏 · 多页签 · 页面内容 · ⌘K · 铃铛 · 个人中心 · 帮助） |
| `tour/gate.ts` | 导览在跑时，新到的公告弹窗先等它结束（`useTourActive`） |
| `help-menu.tsx` | 顶栏 `?` 按钮：功能引导 · 快捷键清单。**看得见的入口**，⌘K 里那条只有知道去搜的人才找得到；阶段 2 的「本页导览」也放这里 |
| `tour/tour.css` | driver.css 的主题映射，跟 `--popover` / `--radius` / `.dark` 走 |

**不自动弹**（2026-11 去掉）：原来首登在仪表盘自动弹一次，用户反馈「每次都弹、不需要」——
「看过了」只记在浏览器本地，换浏览器 / 桌面端 / 清过站点数据都会再弹。现在只从上面两个入口手动开，
也就不再记「看过了」（`preferences.ts` 读到老记录里的 `toursSeen` 直接丢掉）。
要加回自动弹，先翻 git 历史里的 `TourAutostart` 组件（`git log -S TourAutostart`）：当时踩过两个坑 ——「看过了」得在启动成功时记
（driver.js 气泡一出就按 Esc，`onDestroyed` 一次都不跑）、和登录后公告弹窗抢第一屏得让弹窗先。

加一步 = `shell-tour.ts` 加一条 + 目标元素加 `data-tour="…"` + 两个语言包加文案。
漏第二步 `arch:check` 的 `dead-tour-target` 红，漏第三步 `i18n:check` 红。
**不要复用 `data-testid` 当目标**：测试和引导的生命周期不一样。

三条实测出来的：

- 🔴 **裸选择器会命中隐藏页签，而 `arch:check` 看不见。** driver.js 对字串目标是
  `document.querySelector(e)`（1.8.0 产物实读），发生在 node_modules 里，`unscoped-dom-query`
  只扫源码。所以 `TourTarget` 只接受函数、`inTab` 按 tab key 锁、`inShell` 排除 `[data-tab] *`，
  再加一道 `isRendered()`（隐藏页签里的元素 `getClientRects()` 为空）。
  变异验证：把 `tabFrame` 改成不锁 key → E2E 第 2 条当场红（那一步直接消失）
- 🔴 **找不到目标 driver.js 不报错，换一个 0×0 的 dummy 居中弹**（`skipMissingElement` 默认
  false）。RBAC 藏掉按钮的用户会看到一个讲「点这里」却什么都没高亮的弹窗。`resolveSteps()`
  启动前先过滤，一步不剩就不启动。变异验证：去掉过滤 → 进度从 `1 / 5` 变 `1 / 6`
- ⚠️ **`progressText` 不能套 `t()`**：driver.js 的占位符是 `{{current}}` / `{{total}}`，和 i18next
  同形，会被当插值吃掉。另：走过的步骤身上 `driver-active-element` 类**留着**（destroy 时才统一摘），
  E2E 要定位当前高亮元素得加别的限定（`.driver-active-element[data-tab]`）

E2E：`e2e/tests/tour.spec.ts`（第一条守「不自动弹」）。

⚠️ **导览开着时公告弹窗等它结束**（`tour/gate.ts` 的 `useTourActive`）：弹窗是 modal，开着时外面全不可交互，
导览气泡的「下一步」点不动；反过来导览的遮罩盖住弹窗的「我已阅读」。`shell` 不能 import 页面，所以由弹窗那一侧来看导览的状态。
