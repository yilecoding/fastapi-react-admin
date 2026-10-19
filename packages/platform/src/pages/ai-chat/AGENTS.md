# pages/ai-chat —— AI 对话（整页 + 侧滑抽屉）

> 后端那一侧在 [`plugin/ai` 分册](../../../../../apps/api/backend/plugin/ai/AGENTS.md)。
>
> 这份文件是 [`pages` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时
> 才加载。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份。

## 两个入口共用一个 hook，别抄第二份

`use-chat-session.ts` 是整页（`index.tsx`）和抽屉（`drawer.tsx`）**唯一**的对话逻辑：
历史回放、SSE 收帧、发送、自动命名、二次确认、「没有会话就先建一个」。

两个入口只负责各自那件不一样的事，并把它做成一个回调传进去：

| | 怎么建会话 |
|---|---|
| 整页 | `onSearchChange({ c: id })` —— 会话 ID 进 URL（硬纪律 2） |
| 抽屉 | `useAiDrawerStore.setConversationId(id)` |

🔴 **`ensureConversation` 返回的 id 要直接拿去发**，不要等 URL / store 回流到
`conversationId` 再发。等一次渲染的代价见下面那条「历史把流冲掉」。

## 🔴 disabled 的 query 永远停在 `isPending: true`

**症状**：还没选会话时，首屏（`FirstRun`）**从来不出现** —— 用户看到的是一整块白，
外加一个孤零零的输入框。而空状态组件本身写得好好的，代码读起来完全正常。

**根因**：`messagesQuery` 是 `enabled: !!conversationId`。react-query 里
**disabled 的 query 状态一直是 `pending`**，所以

```ts
const showEmpty = bubbles.length === 0 && !historyQuery.isPending   // ❌ 恒为 false
```

**修法**：把「压根没有会话」这一支显式写出来：

```ts
const showEmpty = !conversationId || (bubbles.length === 0 && !historyQuery.isPending && !historyQuery.error)
```

和 [`pages` 分册](../AGENTS.md) 里 `listState(q, { enabled })` 那条是**同一个物种**：
`enabled: false` 的 query 不会自己变成「加载完了、没有数据」。
凡是给 query 挂 `enabled`，都要同时想一遍「关着的时候这几个状态位是什么」。

## 🔴 首条消息：历史会把正在流式产出的内容冲掉

**症状**：新建会话后立刻发第一句，字出到一半**整块消失**（用户那句话和半截回答一起没）。
只在「这个会话的第一条消息」这条路径上发生，手点复现不了几次。

**根因**：会话是刚建的，`messagesQuery(新 id)` 随即发起并返回 `[]`，
而回放历史那个 effect 判的是 `if (!historyQuery.data) return` —— **空数组是 truthy**，
于是 `setBubbles([])` 把正在流的内容清了。

**修法**：流式进行中不接受历史覆盖（复用已有的单飞 ref）：

```ts
React.useEffect(() => {
  if (!historyQuery.data) return
  if (inFlight.current) return        // ← 这一行
  setBubbles(historyQuery.data.map(...))
}, [historyQuery.data])
```

⚠️ 顺带挡住了另一种：后台 refetch 恰好在流式途中返回。

## 会话列表必须按时间分段

标题是**发出去的第一句话**（`deriveTitle`，前 24 字）。在它之前默认全叫「新对话」，
实测一屏 45 条**全同名**，唯一区分是第二行时间戳 —— 那份列表等于没有。
现在 `conversation-list.tsx` 按「今天 / 昨天 / 最近 7 天 / 更早」分段，段标题 sticky。

⚠️ **按自然日算，不是按 24 小时**：23:50 发的，第二天 00:10 该落进「昨天」。
⚠️ 档位刻意粗。档越多每段越少，段标题自己就变成新的噪音。

## 布局：消息贴底，首屏和输入区是同一块

- 🔴 消息容器要 `mt-auto`（整页和抽屉都要）。少了它，一两条消息从**顶部**开始排，
  下面空出一屏高的白 —— 实测就是「一条用户消息挂在右上角、下面 600px 全白」
- 🔴 同一个容器还要 `w-full`。列向 flex 里 auto 外边距会**取消 stretch**，
  盒子退化成按内容定宽，每条消息的左边界跟着自己的内容长度移动
  （实测短内容 711px、输入区 768px）—— 表现是「有些居中有些不居中」
- 首屏（`FirstRun`）把**标题 / 输入框 / 建议**竖成一条一起居中。
  上一版是空状态自己居中一屏、输入框另外钉在底部，两个各自居中、合起来谁也不居中

## 输入框不因为「还没有会话」而禁用

建会话是实现细节。上一版占位符是「先新建一个会话」且 `disabled` ——
点建议卡片的表现是「右边多了个空会话，什么也没发生」，**用户打的那句话被丢掉了**。
现在一律走 `send()`，由它自己 `ensureConversation`。

## 视觉对标 shadcn/ui 的 chat 组件（2026-06）

借的是 anatomy 不是代码（`packages/ui` 本来就是同源的 shadcn + Base UI 底座）：
`Message` 的头像行、`Bubble` 的变体、`Marker` 的分段标题、`shimmer` 等待态。

- 用户气泡用 `bg-primary/10` + `border-primary/15`，**不用 `bg-muted`** ——
  页面里灰块（卡片 / 表头 / 代码块）太多，再来一个灰气泡分不出哪块是「我说的话」。
  淡染跟着 `--primary` 走，换主题不掉队
- 助手侧用**头像**锚点，不用左侧竖线：那条线会和会话栏边框、卡片边框叠成三条平行线
- 等待态是 `shimmer`（`ui/src/styles/globals.css`）：让**那句话自己**发光，
  字出来时原地替换，整块不跳。带 `prefers-reduced-motion` 回落
- 工具轨迹排在正文**上面**并自带容器 —— 它是这个回答的**来源**。
  上一版是几行裸文字浮在旁边，读起来像日志误入了对话
