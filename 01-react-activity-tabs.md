# 用 React 19.2 的 `<Activity>` 做多页签保活，我踩了 6 个坑

先看效果：筛一下、勾两行，切去别的页签转一圈再回来 —— **输入框里的字、勾选的行都还在**。

![切走再切回来，状态原样保留](https://raw.githubusercontent.com/yile2020/fastapi-react-admin/blog/images/00-tabs.gif)

Vue 有 `<keep-alive>`；React 19.2 之前，实现同类需求通常要自行缓存或引入第三方方案。如果多页签只是在路由外面摆一排链接，切走时页面仍然会卸载，填了一半的表单、翻到第 5 页的列表，切回来就归零。

React 19.2 正式发布了 `<Activity>`，终于能正经做这件事了。这篇记录我在一个中后台项目里用它实现多页签时踩过的坑。**每一个都是静默出错的** —— 不报错，只是行为不对。

---

## 先说 `<Activity>` 到底做了什么

```tsx
<Activity mode={visible ? 'visible' : 'hidden'}>
  <Page />
</Activity>
```

`mode="hidden"` 时：

| | 行为 |
|---|---|
| DOM | 保留，加 `display: none` |
| state | 保留 |
| effects | **执行清理函数**；切回 `visible` 时**重新执行** |
| 更新 | 照常渲染，但优先级降低 |

前两行是「切回来还在」的来源。第三行决定了资源如何随可见性收放：在 effect 内建立、并在 cleanup 中停止的订阅和定时器，会随隐藏停止，显示时恢复。模块级定时器、没有写 cleanup 的订阅、共享的数据源不会因此自动暂停。后面好几个坑，也都出在 effect 重建上。React 官方的 [Activity 文档](https://react.dev/reference/react/Activity) 对这些行为有完整说明。

## 基本结构：所有页签同时挂载

`<Outlet />` 只渲染当前匹配的路由，所以要自己把所有打开的页签都渲染出来：

```tsx
export function TabOutlet({ registry }: { registry: PageRegistry }) {
  const tabs = useTabStore((s) => s.tabs)
  const activeKey = useTabStore((s) => s.activeKey)

  return tabs.map((tab) => {
    const Page = registry[tab.routeId]
    const visible = tab.key === activeKey
    return (
      <Activity key={tab.key} mode={visible ? 'visible' : 'hidden'}>
        <Page search={tab.snapshot.search} params={tab.snapshot.params} />
      </Activity>
    )
  })
}
```

- 页签列表放在 zustand 里，持久化到 sessionStorage，刷新后还在。
- 页签的 key 是 `routeId + params`，**不含 search**：同一个页面改筛选条件，不会开出第二个页签。
- 页签达到 20 个后，尝试关掉最早打开、又没固定的那个；全部固定时不会强行关闭。

---

## 坑 1：不能和 `<Outlet />` 混着用

最直觉的写法是：当前页走 `<Outlet />`，后台页走 `<Activity>`。

**不行。** 切换的那一刻，页面从 Outlet 那棵树挪到了 Activity 那棵树。组件在树里的位置变了，React 会卸载再重新挂载，状态照样丢。

所以 `TabOutlet` 必须**完全取代** `<Outlet />`。路由文件只声明 search 校验和守卫，`component: () => null`，页面统一由 `TabOutlet` 按注册表挂载。

## 坑 2：后台页签里读不到路由

路由同一时刻只有一个 location 是「匹配」的。后台页签依然挂载着，但它里面调 `Route.useSearch()` / `Route.useParams()` 拿不到自己的 match。

所以页面组件必须和路由无关：search 和 params 都走 props；要改 URL，就调外面注入进来的 `onSearchChange`：

```tsx
// ✅ 页面只认 props
export function UserPage({ search = {}, onSearchChange }: {
  search?: UserSearch
  onSearchChange?: (next: UserSearch) => void
}) { … }

// ❌ 页面自己读路由
const search = Route.useSearch()
```

`onSearchChange` 由 `TabOutlet` 为每个页签各生成一份，导航时用 `replace`，免得改一次筛选就多一条历史记录：

```tsx
const onSearchChange = (next) =>
  navigate({ to: pathname, search: dropEmpty(next), replace: true })
```

筛选、分页、选中项全部写进 URL。`<Activity>` 只在**会话内**保活，一刷新就没了，URL 才能跨刷新。两者缺一不可。

这条靠自觉守不住，项目里用一个静态检查脚本拦：页面代码里出现 `Route.useSearch()` / `Route.useParams()` / `useNavigate()`，CI 直接红。同一个脚本也会检查没限定范围的 `document.querySelector`（见坑 5）。

### 顺带一个同步页签的坑

把「当前路由」同步进页签列表时，要用 `resolvedLocation`，并且等 `status === 'idle'` 再同步：

```ts
const snap = useRouterState({
  select: (s) => ({
    idle: s.status === 'idle',
    leaf: s.matches[s.matches.length - 1],
    href: (s.resolvedLocation ?? s.location).href,
  }),
})
```

TanStack Router 导航时会**先**改 `location`，**再**解析 `matches`。中间这段时间，`matches` 还是旧路由，`location` 已经是新地址。这时候同步，旧页签的 href 会被写成新地址：点它跳不过去，两个页签还会撞成同一个 key（React 报 duplicate key）。

## 坑 3：effect 会被「重建」，依赖数组分不清「变了」和「回来了」

这是 E2E 抓到的一个真 bug。

树形表格有个「全部展开 / 全部折叠」开关 `foldAll`，用户还能单独点开某个节点。原来的写法是：`foldAll` 一变，就清掉单独点过的记录。

```ts
const [flipped, setFlipped] = useState(new Set<string>())
useEffect(() => setFlipped(new Set()), [foldAll])   // ❌
```

现象：在部门管理里折叠一个节点，切到角色管理，再切回来，**折叠状态没了**。

原因：页签切回 `visible` 时，`<Activity>` 会把 effect 重新执行一遍。新建的 effect 第一次执行时，依赖数组里是什么都会跑。于是每切回来一次，它都以为 `foldAll` 变了，把用户手动折叠的记录清空。`flipped` 这个 state 其实被保活得好好的，是这个 effect 自己把它清掉的。

修法：用 ref 记住上一次真正生效的值。ref 和 state 一样会被保活，比对才成立：

```ts
const lastFoldAll = useRef(foldAll)
useEffect(() => {
  if (lastFoldAll.current !== foldAll) {
    lastFoldAll.current = foldAll
    setFlipped(new Set())
  }
}, [foldAll])
```

**结论**：凡是「靠 `useEffect` 响应某个值的变化」的写法，只要组件会被隐藏再显示，都要检查一遍。依赖数组只能告诉你「effect 跑了」，不能告诉你「值变了」。

## 坑 4：「重新加载当前页」在 30 秒内什么都不做

页签右键菜单里有「重新加载」。页面被保活着，不换 key 是刷不掉的，所以给每个页签加一个 `revision`，拼进页面组件的 key：

```tsx
<Activity key={tab.key} mode={…}>
  <TabFrame key={`${tab.key}#${tab.revision}`} … />
</Activity>
```

`revision + 1` → 页面卸载重挂。注意 `<Activity>` 自己的 key 不变，保活边界不会被重建。

然后发现：**30 秒内点「重新加载」，一个请求都不发**。

原因是全局设了 `staleTime: 30_000`。页面重挂了，但 react-query 认为数据还新鲜，`refetchOnMount` 直接给缓存。一个按钮的行为取决于「你上次看它是几秒前」，这是最难排查的那种坏法。

修法：重挂的同时让缓存失效，并且只重取当前可见的页面：

```ts
qc.invalidateQueries({ refetchType: 'active' })
```

本项目的隐藏页签在 effect 清理后不再观察自己的 query；只被这些页面使用的 query 会标记为过期，切回来再取。若同一个 query 还被顶栏或其他可见组件订阅，它仍是 active，也会重取。这里的 active 是 query 的观察状态，不是「只刷新某一个路由」。全局的 `staleTime` 不改：30 秒本来就是为了减少重复取数。

## 坑 5：隐藏页签的 DOM 还在文档里

`display: none` 不等于不存在：

- **`document.querySelector`** 会命中后台页签里的元素。我录上面那张 GIF 时就中招了：脚本去找输入框，找到的是后台页签里那个看不见的，一直等它出现，直到超时。
- **测量尺寸**会拿到 0。recharts 的 `ResponsiveContainer` 要测容器宽度，放在后台页签里就是宽 0。监控页的趋势线最后换成了固定 `viewBox` 的内联 SVG，纯 CSS 缩放，不测量。
- **第三方库的全局选择器**也一样。功能引导用的 driver.js，传字符串选择器时内部就是 `document.querySelector`，会高亮到后台页签里的元素。

所以每个页签的根节点上都带两个属性，全局查询一律限定在可见页签内：

```tsx
<div data-tab={tab.routeId} data-visible={visible}>…</div>
```

```ts
document.querySelector('[data-visible="true"] .xxx')
```

**但 `data-visible="true"` 也不是瞬时唯一的。** 切换时有一小段窗口，新旧两个页签都是 `true`：

- 应用内切换，实测约 **18ms**。
- 整页刷新后，实测约 **300ms**。激活哪个页签要等 effect 从 sessionStorage 纠正回来，而隐藏子树的提交优先级又比较低。

要精确锁定某个页面，就按路由 ID 锁：`[data-tab="/_auth/system/user"]`。写 E2E 时尤其要注意，否则 strict mode 会同时匹配到两个元素。

## 坑 6：开在 URL 上的抽屉，会从后台「飘」到前台

这个最难查。

审批中心的详情抽屉开在 `?id=xxx` 上。刷新之后，审批中心这个页签在**后台**被恢复出来，`search.id` 还在，抽屉也就照样以「打开」状态挂载了。

问题是抽屉通过 portal 挂在 `<body>` 下，**不在 `<Activity>` 隐藏的那棵 DOM 里**。于是它盖在前台的消息中心上面，把点击全挡住了。用户看到的是：这个页面点什么都没反应。

试了三种办法，前两种都不行，第三种还有个坑：

| 做法 | 结果 |
|---|---|
| 后台时传 `open={false}` | Base UI 关浮层要等退场动画的 effect 跑完才卸载 portal，可后台页签的 effect 已经被清理了。那个「已经关掉」的抽屉一直留在屏幕上 |
| 后台时直接 `return null` | 不挡了，但切一下页签，填了一半的申请表单、写好的审批意见全没了 |
| 把 portal 挂进本页签的根节点 | ✅ 页签隐藏，抽屉跟着隐藏，里面的状态照样保活 |

第三种的实现：页签根节点通过 context 往下传，浮层把它当 portal 容器：

```tsx
const TabContainerContext = createContext<HTMLElement | null | undefined>(undefined)
export const useTabPortalContainer = () => useContext(TabContainerContext)

function TabFrame({ … }) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  // 🔴 忽略 null：<Activity> 隐藏时会把 ref 解绑成 null，但 DOM 节点其实还在
  const keepContainer = useCallback((el: HTMLElement | null) => {
    if (el) setContainer(el)
  }, [])

  return (
    <div ref={keepContainer} data-tab={tabKey} data-visible={visible}>
      <TabContainerContext.Provider value={container}>
        <Page … />
      </TabContainerContext.Provider>
    </div>
  )
}

// 页面里
<SheetContent container={useTabPortalContainer()}>…</SheetContent>
```

注释里忽略 ref 解绑的处理是 E2E 抓到的：`<Activity>` 隐藏时会解绑 ref，但节点仍在。跟着清空 container 会改变 portal 的挂载状态，切回来表单可能已经是新节点。

这里还有三个值，不能混用：元素表示挂进本页签；`null` 表示在页签里、容器还没就绪，Base UI 会等待；`undefined` 表示不在任何页签里，允许回落到 `<body>`。如果 context 默认给 `null`，同一个抽屉放进顶栏铃铛后会一直等容器，看起来就像「点了没反应」。调用处也不要用 `container ?? undefined` 把等待状态抹掉。

**由 URL 驱动的浮层**需要随页签保活。用 `useState` 点开的浮层也要检查离开方式：如果关闭和路由跳转发生在同一次提交里，退场动画可能来不及跑完。对这类不需要保活的临时弹窗，项目在离开时直接卸载；不能假定「先设 open=false，再跳转」一定已经完成关闭。

---

## 总结：一份检查清单

| 检查项 | 不做会怎样 |
|---|---|
| 用 `TabOutlet` 完全取代 `<Outlet />` | 切换时当前页照样卸载 |
| 页面不读路由，search/params 走 props | 后台页签拿不到自己的参数 |
| 视图状态写进 URL | 刷新后全丢 |
| 同步页签用 `resolvedLocation` + `idle` | 页签 href 写错、key 撞车 |
| 响应值变化的 effect 用 ref 比对 | 每次切回来都「重置」一次 |
| 「重新加载」要换 key，同时让缓存失效 | 30 秒内是空操作 |
| 全局 DOM 查询限定在 `[data-visible="true"]` 或 `[data-tab]` 内 | 命中后台页签，或测出 0 宽 |
| URL 驱动的浮层挂进本页签根节点 | 后台抽屉挡住前台点击 |

文中代码摘自我的开源项目 [fastapi-react-admin](https://github.com/yile2020/fastapi-react-admin)，示例省略了业务细节。完整实现在 [tab-outlet.tsx](https://github.com/yile2020/fastapi-react-admin/blob/main/packages/platform/src/shell/tab-outlet.tsx)，浮层离开与保活的回归测试见 `overlay-leave.spec.ts`、`workflow.spec.ts` 和 `notice-reach.spec.ts`。项目的[系统介绍](https://juejin.cn/post/7703586144182321186)已发布，也可以在[在线演示](https://fra.wubunan.com)（`admin` / `123456`）里多开几个页签试试。

你们的 React 项目里，多页签是怎么做的？有没有踩过别的坑？欢迎评论区聊聊。
