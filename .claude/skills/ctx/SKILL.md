---
name: ctx
description: 把一条刚踩出来的坑写进项目上下文文档（分册 AGENTS.md）。用户说「记一条」「记下来」「这个坑记进文档」「更新 CLAUDE.md」，或刚修完一个静默失败的 bug 需要沉淀结论时使用。
---

# 往上下文文档里加一条结论

这个仓库的文档是**踩坑记录**，不是使用手册。判据只有一条：

> **违反了会坏，而且多数是静默地坏。**

不满足这条的不要写进去 —— 风格偏好、能从代码直接读出来的事实、
一次性的调试过程，都不属于这里。写进去只会稀释真正重要的那些条目。

## 一、先定位写到哪一份

**写到离代码最近的那一份**，不要往根 `CLAUDE.md` 堆。根文件在会话开始时
全量加载，而分册是读到那个目录的文件时才惰性加载 —— 写在分册里不占别人的预算。

| 结论关于… | 写进 |
|---|---|
| 通用组件、尺寸覆盖失效、组件选型 | `packages/ui/AGENTS.md` |
| 查询区字段 / 运算符 / 出参映射 | `packages/ui/src/components/query-bar/AGENTS.md` |
| 富文本、内联图、公开子树 | `packages/ui/src/components/rich-text/AGENTS.md` |
| 多页签、偏好、侧边栏、外壳滚动 | `packages/platform/src/shell/AGENTS.md` |
| 页面模板、四种页型、页面滚动骨架 | `packages/platform/src/pages/AGENTS.md` |
| 文件上传 / 预览 / 附件 | `packages/platform/src/pages/file/AGENTS.md` |
| 文案、语言包、两个校验脚本 | `packages/i18n/AGENTS.md` |
| 后端模型 / 接口 / SQL / pytest | `apps/api/AGENTS.md` |
| Playwright E2E | `apps/web/e2e/AGENTS.md` |
| **跨模块**、任何一层都可能违反的 | 根 `CLAUDE.md` 的「硬纪律」，并给个编号 |

新目录还没有分册就新建一份：`<目录>/AGENTS.md` 真身 +
`ln -s AGENTS.md <目录>/CLAUDE.md`（Claude Code 只认 `CLAUDE.md`，
其余 agent 工具认 `AGENTS.md`）。

## 二、按这个仓库的文体写

一条合格的结论有四件东西，缺了「症状」和「实测」的条目没人敢信：

1. **症状** —— 界面上/日志里看到的是什么。写得越具体越好，
   下一个人是靠症状检索到这条的，不是靠根因
2. **根因** —— 为什么会这样
3. **修法** —— 改哪里，以及**为什么不能改在别处**
4. **实测证据** —— 具体数字、具体报错原文。「实测」两个字是这份文档的信用基础

排版沿用现有习惯：真的会让人损失时间的用 `🔴`，需要留意的用 `⚠️`，
对照关系用表格，反例用 `❌` / 正例用 `✅`。

反面例子（不要这样写）：

> - tooltip 要正确使用 TooltipTrigger

正面例子：

> 🔴 **`TooltipTrigger render={<span className="contents" />}` 会把气泡甩到视口左上角。**
> `display:contents` 不生成布局盒，`getBoundingClientRect()` 返回全 0，
> 而 Base UI 拿这个 span 当定位参照。实测（`@base-ui/react@1.7.0`）：
> 按钮在 `{x:308,y:308}`，气泡落在 `{x:0,y:4}`。
> 修法是把 `render` 直接指向按钮本身（`TooltipTrigger render={trigger} />`），
> 三层嵌套 `TooltipTrigger → DropdownMenuTrigger → Button` 也成立，实测已贴合。

## 三、收尾必做

```bash
pnpm ctx:check
```

它核对「指向的东西还在不在」（死路径 / 死链接 / 死脚本 / 死 testid / 行数预算）。
**它不校验文字对不对** —— 那还是要人读。

如果这条结论提到了一个**刻意不存在**的东西（讲「这个已经删了」「这条路走不通」），
把它登记进 `scripts/ctx-check.mjs` 的 `ALLOW` 表**并写上理由**。
没有理由的豁免，下一个人就不敢删了。

分册超过 500 行时 `budget` 会警告 —— 那是「该再往下拆一层」的信号，
按子目录拆，不要靠删内容压行数。
