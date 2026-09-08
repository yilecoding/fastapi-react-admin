# 把 `packages/ui` 搬进你自己的项目

这个包的定位是**被整包拿走自己改**（shadcn 那个模型：组件是你拥有的代码，
不是你消费的包）。所以这份文档不是「怎么 import」，是**怎么搬走**。

搬走之后它就是你的代码了 —— 改样式、删组件、换图标库都不用问我们，
也不用等发版。

---

## 一、拷什么

```
packages/ui/src/
├─ components/     45 个组件（含 4 个目录形态的复杂组件）
├─ lib/            utils.ts（cn）· i18n.ts（翻译入口）
├─ hooks/          use-mobile.ts
└─ styles/
   └─ globals.css  🔴 必须一起拿走，见第三节
```

放进你项目的哪里都行，惯例是 `src/components/ui/`（shadcn 的默认位置）。
唯一要改的是 import 前缀：本仓库里是 `@admin/ui/components/xxx`
（走 `package.json` 的 `exports` 做**包自引用**），你那边换成
`@/components/ui/xxx` 之类。一条 sed 的事：

```bash
grep -rl '@admin/ui/' src/components/ui | xargs sed -i 's|@admin/ui/|@/components/ui/|g'
```

⚠️ 有几个文件用的是**相对路径**（`../lib/i18n`），那些不用改。

## 二、装什么

照抄 `packages/ui/package.json` 的 `dependencies`。它对 workspace **零依赖**
（没有一条 `@admin/*`），所以整段可以直接搬。

按需裁剪的对照表 —— 不用某个组件就连它的依赖一起删：

| 依赖 | 谁在用 | 不要的话 |
|---|---|---|
| `@base-ui/react` | 几乎所有组件 | 删不掉，这是底座 |
| `@tabler/icons-react` | 全部（图标） | 换 lucide 也行，全局替换图标名 |
| `class-variance-authority` · `clsx` · `tailwind-merge` | `cn()` 和所有带 variant 的组件 | 删不掉 |
| `@tanstack/react-table` · `@tanstack/react-virtual` | `data-table` · `data-grid` | 不要表格就删这两个组件 + 依赖 |
| `@dnd-kit/*` | `data-grid` 的列拖拽 | 同上 |
| `@tiptap/*` | `rich-text` | 不要富文本就删这个目录 + 全部 `@tiptap/*` |
| `@file-viewer/*` | `file-viewer` | 不要文件预览就删这个目录 + 全部 `@file-viewer/*` |
| `react-day-picker` | `calendar` · `datetime-picker` | 不要日期就删这两个 |
| `react-i18next` · `i18next` | 15 个组件的文案 | 见第四节，可以拆掉 |
| `@fontsource-variable/*` | `globals.css` 的字体 | 换字体就删，同时改 `globals.css` 顶部的 `@import` |
| `tw-animate-css` · `shadcn` | `globals.css` | 删不掉（动画工具类和 shadcn 的基础层） |

## 三、🔴 `globals.css` 必须一起拿走

只拷 `components/` 会得到一个**样式全裸**的库 —— class 都在、CSS 规则不在。
`globals.css` 里有四样东西是组件直接依赖的：

1. **设计令牌**（`--primary` / `--muted` / `--radius` / `--scrollbar-thumb` …）。
   45 个组件文件里**一个 `#rrggbb` 都没有**，全走变量 ——
   换主题色 / 圆角 / 密度 / 暗色，改这一个文件就够，不用碰组件
2. **`dark` 变体**：`@custom-variant dark (&:is(.dark *))`。
   本仓库是往 `<html>` 上加 `.dark` 类；你要用 `prefers-color-scheme`
   就改这一行，组件不用动
3. **`content-scroll` / `page-scroll` 变体**（见下）
4. **滚动条外观**（`scrollbar-width: thin`）。刻意不用 `::-webkit-scrollbar` ——
   那会强制 macOS 退回常驻滚动条

还要确认 **Tailwind 的 `@source`** 指向你的源码目录：

```css
@source "../../../../apps/*/src/**/*.{ts,tsx}";
@source "../../../../packages/*/src/**/*.{ts,tsx}";
```

这两行是相对 **CSS 文件所在目录**算的，搬走之后一定要改。
漏了的后果是**静默的**：class 在、CSS 规则不在，表现为「布局莫名其妙塌掉」。

### `content-scroll:` 这个变体是干什么的

两种滚动方式：`content-scroll` 是「外壳锁在视口内、只有主内容区滚」（默认），
`page-scroll` 是「整份文档跟着滚」。`DataTable` / `Table` 用
`content-scroll:min-h-0` / `content-scroll:flex-1` 把自己变成定高视区
（表头钉住、只有行在滚）。

**你不用做任何事** —— 变体写成「**不是** page 就生效」：

```css
@custom-variant content-scroll (&:not([data-scroll-mode="page"] *));
```

没有人写 `data-scroll-mode` 时它就是默认的 content 模式。
想让整页滚，往 `<html>` 上写 `data-scroll-mode="page"`。

> 📌 这里原来写的是 `[data-scroll-mode="content"] &` —— 要求**外部**
> 往 `<html>` 上写这个属性（本仓库里是 `platform` 的偏好设置在写）。
> 只拿 ui 不拿 platform 时那些类**全变空操作**：表格永远不会变成定高视区，
> 表头跟着行一起滚走，而 DevTools 里那些 class 明明都在。
> 这就是这份文档要消灭的那类问题 —— 不报错、不崩，只是行为悄悄不对了。

## 四、翻译：接、还是拆掉

15 个组件有文案（分页条、查询区、富文本工具栏、错误块…）。它们全走
`lib/i18n.ts` 的 `useT()`，**不直接 `useTranslation()`**。

本仓库的策略是「**中文原文即 key**」：`t('重试')` 的 key 就是「重试」。
所以三条路都能走：

### A. 什么都不接（最省事）

`useT()` 在没有 i18next 实例时回落到内置兜底：**原样返回 key + 做插值**。
你得到的是一个中文界面，插值正常。

⚠️ 这条兜底是必须的，不是锦上添花。裸 `react-i18next` 在没实例时
`t('共 {{total}} 条', {total: 42})` 返回的是字面量 `共 {{total}} 条` ——
满屏中文看着一切正常，只有带数字的那几条显示成模板源码。

### B. 接上你自己的 i18next

```ts
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
i18next.use(initReactI18next).init({ lng: 'zh-CN', resources: { … } })
```

`useT()` 检测到 `i18n.isInitialized` 就走真实例。key 清单直接从
`packages/i18n/src/locales/zh-CN.json` 里挑本包用到的那些
（都是中文原文，一眼能认出来）。

### C. 拆掉 i18n

改 `lib/i18n.ts` 一个文件：

```ts
export type TFn = (key: string, opts?: Record<string, unknown>) => string
export function useT(): TFn { return __fallbackT }   // 只留兜底
```

然后删掉 `react-i18next` / `i18next` 两个依赖。组件一行都不用改 ——
这正是当初把 `useTranslation()` 收进一个入口的理由。

## 五、有没有对 `platform` 的依赖

**零。** 有闸门守着（`pnpm arch:check` 的方向规则：`ui` 不能依赖 `platform`）。

但有两处组件**把能力开口留给了外部**，不接就是功能关掉，不是报错：

| 组件 | 开口 | 不接会怎样 |
|---|---|---|
| `rich-text` | `images` prop（上传 / 删除 / 取 URL） | 图片相关的工具栏按钮整块隐藏，其余功能正常 |
| `file-viewer` | `buffer`（带鉴权取回的字节） | 没字节就没东西可渲染。**不要改成传 url** —— renderer 自己发的请求带不上 Authorization 头，拿回来的是 401 的 JSON |

## 六、验一遍搬得对不对

```bash
# 1. 样式：随便开一个页面，看按钮有没有背景色
#    全是白底黑字 = @source 没指对（第三节）
# 2. 表格：DataTable 滚动时表头有没有钉住
#    表头跟着滚 = content-scroll 变体没拿到（第三节）
# 3. 插值：分页条上是「共 42 条」还是「共 {{total}} 条」
#    后者 = 有人绕过 useT() 直接用了 useTranslation()（第四节）
# 4. 深色：往 <html> 加 class="dark"，颜色要整体反过来
#    只有一部分变 = 有组件写死了颜色，grep '#[0-9a-f]\{6\}' 找出来
```

第 2、3 条是**静默失效**，界面上不会有任何报错 —— 所以这份清单值得真的跑一遍。

## 七、还有一份可读的目录

本仓库跑起来之后，`/sandbox/components` 是这个库的**完整目录**：
按「基础组件 / 复杂组件 / 设计令牌」三层列全部组件，每个带

- 一句「什么时候用」和「什么时候别用」
- 铺开的变体对比
- 旋钮 + 实时生成的代码（只包含和默认值不同的 prop，抄走就能用）

搬走之后你也可以把 `platform/src/pages/dev-sandbox/` 一起拿走 ——
它只依赖 `ui`，不依赖别的业务代码。
