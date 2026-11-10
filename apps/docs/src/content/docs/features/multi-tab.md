---
title: 多页签保活
description: 已打开的页签用 React 19.2 的 <Activity> 同时挂载，切走不丢表单和树的展开状态；筛选、分页写进 URL，刷新也还在。
sidebar:
  order: 2
---

登录后的外壳把所有打开过的页面**同时挂载**，用 React 19.2 的 `<Activity>` 把不在前台的那些藏起来。切页签时 DOM 和 React 状态都留着 —— 填了一半的表单、手动折叠的树节点、输入框里没提交的字；筛选、分页、选中项这些视图状态另外写进 URL，所以刷新页面也不会丢。

## 在界面上哪里找？

| 操作 | 怎么做 |
|---|---|
| 打开页签 | 点侧边栏、⌘K 命令面板、页面里的链接；已经开着的页面不会重复开 |
| 页签菜单 | **右键**点页签：重新加载 · 固定 / 取消固定 · 关闭 · 关闭左侧 / 右侧 / 其它 / 全部标签页 · 在新窗口打开 |
| 关闭 | 页签上的 ×，或鼠标**中键**点页签 |
| 排序 | 拖拽页签 |
| 看全部已开的页签 | 标签条右侧的总览下拉，带数量，点一行直接跳过去 |
| 外观与开关 | 个人中心 →「多标签页」：显示多标签页、标签页外观（按钮 / 卡片 / 柔和 / 下划线）、显示图标、中键关闭、拖拽排序。存在浏览器本地，见[工作台与界面](/features/workspace/#外观能调哪些) |

关掉「显示多标签页」只是不显示标签条，页签机制本身照常工作（这个开关只控制标签条渲不渲染）；功能引导会跳过介绍页签的那一步。

## 原理是什么？

[`TabOutlet`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/tab-outlet.tsx) **完全取代**路由的 `<Outlet />`。`<Outlet />` 只渲染当前匹配的那一个路由，`TabOutlet` 则给每个已打开的页签各渲染一个 `<Activity>`：

```tsx
return tabs.map((tab) => {
  const Page = registry[tab.routeId]
  const visible = tab.key === activeKey
  return (
    <Activity key={tab.key} mode={visible ? 'visible' : 'hidden'} name={tab.key}>
      <TabFrame key={`${tab.key}#${tab.revision ?? 0}`} /* params、search、Page … */ />
    </Activity>
  )
})
```

`hidden` 模式下，React 保留 DOM（加 `display: none`）和组件状态，但会执行 effect 的清理函数，等页签重新可见时再把 effect 建一遍。所以后台页签表单还在，轮询却停了。

页签列表是一个很小的 zustand store（[`tab-store.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/tab-store.ts)），持久化在 `sessionStorage` 的 `admin:tabs` 里：

- 页签的 key 是 `routeId` + params，**不含 search** —— 改筛选条件只更新当前页签，不会再开一个。
- 最多 20 个。开第 21 个时，关掉标签条上最左边那个没固定的。
- 固定的页签排最前、不能关。右键菜单有：关闭、固定、重新加载、在新窗口打开、关闭左侧 / 右侧 / 其它 / 全部。中键关闭、拖拽排序（只能在固定区或非固定区内部拖）都可以在外观设置里开关。

## 为什么切回来，填了一半的表单还在？

因为页面组件从头到尾没被卸载过。切走只是藏起来，同一个组件实例一直在内存里，切回来再显示 —— 并没有「从缓存恢复」这一步。

有一种情况要额外处理：由 URL 打开的抽屉（审批中心的详情抽屉开在 `?id=` 上）。浮层通过 portal 挂在 `<body>` 下，不在被隐藏的那棵 `<Activity>` 子树里。刷新之后，审批中心这个页签在后台被恢复出来、抽屉照样是打开的，结果它盖在前台页面上，把所有点击都挡住了。后台时传 `open={false}`，抽屉会一直停在屏幕上（Base UI 要等退场动画的 effect 跑完才卸载，而这个 effect 已经被 `<Activity>` 清理掉了）；后台时干脆不渲染，草稿又没了。最后的做法是把 portal 挂进本页签自己的根节点：

```tsx
<SheetContent container={useTabPortalContainer()}>…</SheetContent>
```

提供这个根节点的 ref 回调会**忽略 `null`**：`<Activity>` 隐藏子树时会把 ref 解绑成 `null`，但那个 DOM 节点其实还在。只有 URL 驱动的浮层需要这么做；用 `useState` 点开的浮层，在你能切页签之前就已经关掉了。

## 为什么视图状态还要写进 URL？

`<Activity>` 只在内存里保状态，刷新页面等于重启整个 JS 运行时，所以要跨刷新的东西必须进 search 参数。路由文件只声明 zod 校验、守卫和标题，自己不渲染任何东西：

```tsx
export const Route = createFileRoute("/_auth/system/user")({
  validateSearch: searchSchema,   // page、size、username、status、dept、role、隐藏的列…
  beforeLoad: requirePerm("sys:user:del"),
  staticData: { title: "用户管理" },
  component: () => null,
})
```

每个页签的地址和 search 快照都存在 `sessionStorage` 里，刷新之后所有页签带着各自的筛选条件回来；没提交的表单输入则不会回来。

两个细节：

- **粗粒度进 URL，细粒度留内存。** 树形表格只往 URL 写一个 `fold=all`，逐个点开的节点留在组件 state 里（[`use-tree-fold.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/_shared/use-tree-fold.ts)）。菜单树有 65 个节点、每个 ID 19 位，全塞进地址栏没法看。
- **雪花 ID 必须保持字符串。** TanStack Router 默认对 search 值跑 `JSON.parse`，`?role=2202097973238829056` 会变成 `2202097973238829000`，实测权限矩阵被保存到了另一个角色上。[`search-params.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/src/lib/search-params.ts) 让超出 `Number.MAX_SAFE_INTEGER` 的纯整数保持字符串。

## 为什么页面不能自己读路由？

路由同一时刻只有一个 location 是「匹配」的。后台页签虽然还挂着，但它里面的 `Route.useSearch()` / `Route.useParams()` 拿不到属于自己的 match。所以页面的参数全部走 props，改 URL 则调用 `TabOutlet` 给每个页签单独生成的回调：

```tsx
export function UserPage({ search = {}, onSearchChange }: {
  search?: UserSearch
  onSearchChange?: (next: UserSearch) => void
}) { … }
```

`onSearchChange` 会去掉空值，并用 `replace: true` 导航，改一次筛选不会多一条浏览器历史。页签同步读的是 `resolvedLocation`，而且要等路由 `idle` 才同步：TanStack Router 导航时先改 `location`、后解析 `matches`，在这个空档里同步，会把新地址写到旧页签上（React 随后报 duplicate key）。

## 后台页签里的 effect、轮询、定时器会怎样？

会停。`<Activity>` 清理了隐藏页签的 effect，React Query 的观察者随之脱离，监控页的定时器也停了 —— 后台挂着三个监控页，不会一起打后端。

坑在于页签切回来时 effect 会被**重建**，而新建的 effect 一定会先跑一次。像 `useEffect(() => reset(), [foldAll])` 这种写法，分不清「值变了」和「页签回来了」。部门管理就因此每切一次页签，手动折叠的节点就被清空一次，直到端到端测试把它抓出来。修法是用 ref 记住上一次真正生效的值再比对 —— ref 和 state 一样会被保活：

```ts
const lastFoldAll = React.useRef(foldAll)
React.useEffect(() => {
  if (lastFoldAll.current !== foldAll) {
    lastFoldAll.current = foldAll
    setFlipped(new Set())
  }
}, [foldAll])
```

## 页面从不卸载，「重新加载」怎么生效？

「重新加载」把页签的 `revision` 加一，它拼在页面组件的 `key` 里，于是页面卸载重挂，而 `<Activity>` 这层边界不动。光这样还不够：全局 `staleTime: 30_000` 让 React Query 直接给缓存，实测「重新加载」在 30 秒内**一个请求都不发**（issue #36）。现在它同时调用 `invalidateQueries({ refetchType: 'active' })`：只有当前可见的页面立刻重取，后台页签只标记过期，切回来再取。

## 全局查 DOM 会出什么问题？

隐藏页签的 DOM 还在文档树里：

- `document.querySelector` 会命中后台页签里的元素。
- 在 `display: none` 里测尺寸拿到的是 0。监控页的趋势线因此改成了固定 `viewBox` 的内联 SVG，不再用需要测量容器宽度的图表组件。
- 第三方库用字符串选择器也一样 —— 功能引导的目标只接受函数，在可见页签内部解析。

每个页签的根节点都带 `data-tab` 和 `data-visible`。查询请限定在 `[data-tab="/_auth/system/user"]` 这样的范围里：切换页签时会有一小段时间两个页签的 `data-visible` 同时是 `true`，实测应用内切换约 18ms，整页加载后约 300ms。

## 退出登录、换账号时呢？

登录和退出时都会清空页签，未登录状态下同步逻辑不往标签条里加任何东西（否则退出后它会把当前页又加回去，issue #29）。外观偏好不清。已知没覆盖的情况：用户在线时被管理员收回权限，已经开着的页签会留到关掉为止，点开会跳 `/403`。

## 新增页面要守的规矩

下面三条由 CI 里的 `pnpm arch:check` 拦（[`scripts/arch-check.mjs`](https://github.com/yilecoding/fastapi-react-admin/blob/main/scripts/arch-check.mjs)）：

1. `packages/platform/src/pages/` 里不许出现 `Route.useSearch()`、`Route.useParams()`、`useNavigate()`，一律走 props。
2. `apps/web/src/routes/_auth/` 下的路由文件写 `component: () => null`，页面登记在 [`page-registry.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/src/lib/page-registry.tsx)。
3. `document.querySelector` / `getElementById` 必须带 `data-tab` 或 `data-visible` 限定。

脚本拦不住、要自己记得的：筛选 / 分页 / 选中项写进 `validateSearch`；URL 驱动的抽屉用 `useTabPortalContainer()`。

## 代码在哪

- [`shell/tab-outlet.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/tab-outlet.tsx) —— `TabOutlet`、`TabFrame`、`useTabPortalContainer`
- [`shell/tab-store.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/tab-store.ts) · [`shell/use-sync-tabs.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/use-sync-tabs.ts) · [`shell/use-tab-actions.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/shell/use-tab-actions.ts)
- [`apps/web/src/routes/_auth.tsx`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/src/routes/_auth.tsx) —— `TabOutlet` 挂载的地方

## 怎么测的

Playwright 走真实的客户端路由（点链接，不用 `page.goto` —— 那是整页刷新，会把运行时重启一遍）：

- [`tabs.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/tabs.spec.ts) —— 部门管理 → 角色管理 → 部门管理，手动折叠的节点还是折叠的；隐藏页签仍在文档树里，标着 `data-visible="false"`。
- [`workflow.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/workflow.spec.ts) —— 填到一半的抽屉切走再切回来草稿还在，且后台的抽屉不挡前台页面。
- [`list-refresh.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/list-refresh.spec.ts) —— 「重新加载」真的重新取数；[`session-tabs.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/session-tabs.spec.ts) —— 用两个权限不同的账号验证不残留上一个人的页签。

## 在演示环境里试试

用 `admin` / `123456` 登录[在线演示](https://fra.wubunan.com/sign-in)。打开 **系统管理 → 部门管理**，折叠一个节点，再打开 **系统管理 → 角色管理**，然后切回来 —— 节点还是折叠的。在 **系统管理 → 用户管理** 里筛选一下，切走再切回来，再刷新页面：筛选条件还在地址栏里，列表也还是筛过的。

相关：[数据权限](/features/data-permissions/)决定一个人能打开哪些页签、看到哪些行。
