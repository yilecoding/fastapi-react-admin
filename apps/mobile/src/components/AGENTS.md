# apps/mobile/src/components —— 移动端 UI

> 这份文件是 [`apps/mobile` 分册](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载它。

组件来自 `react-native-reusables`（RN 版的 shadcn），令牌在 `../styles/global.css`。
**风格是 iOS 分组列表**，不是 web 那套「白页 + 描边卡片」——为什么这么定、以及自创令牌那次翻车，都在下面。

## UI：**iOS 分组列表**，组件来自 `react-native-reusables`

风格是**给用户画了两轮候选图之后定的**，不是猜的：第一轮四套大方向（shadcn 卡片 /
iOS 分组 / 深色控制台 / Material 3）→ 选 iOS；第二轮在 iOS 里做四个变体
（系统原味 / 品牌头 / 白底纸感 / 深色分组）→ 浅色取「**品牌头**」，深色取
「**深色分组**」。

🔴 **在此之前连着四版难看，根因是同一个：只抄了模板里的 `button` / `text` / `icon`
三个组件，剩下全自己发明。** 组件从 CLI 装：

```bash
cd apps/mobile
npx @react-native-reusables/cli@latest add card avatar badge separator input label alert tabs skeleton checkbox --styling-library uniwind
```

### 令牌：主色跟 web，中性色是移动端自己一套

`--color-primary` 仍是**品牌紫，和 `packages/ui` 同步**（web 改了要跟着改）。
但**中性色刻意不照抄 web**：

| | web | 移动端 |
|---|---|---|
| 表面语义 | 白页 + **描边卡片**（桌面） | **iOS 分组列表** |
| `background` | 纯白 | `#F4F2FA` 带一点 277 偏色的浅灰底 |
| `card` | 白 + 1px 描边 | 纯白**分组块**、无描边 |
| `border` | 描边 | 只当**分隔线**用，浅得多 |

硬套 web 的灰会得到一堆看不见的分隔线和糊在一起的层级。深色那套是 iOS 深色设置
的原值（`#000` 页 / `#1C1C1E` 块 / `#2C2C2E` 线），并把主色提亮到 `#6B57FF` ——
`#4630DB` 在纯黑上几乎读不出来。

🔴 值用 hex 不用 oklch：这些是**取自系统的定值**，不是从品牌色派生的。

🔴 **`--color-*` 必须在 light 和 dark 里都声明、数量一致。** uniwind 会校验，
少一个就打 `Theme light is missing variable --color-xxx`，**但 `expo export` 仍然
返回成功、照样产出 bundle**，只是那批变量没生效 —— 表现为「某个颜色是隐形的」。实测踩过。

### 🔴 主色和语义色只能出现在这几处

实测被指出过两次，两次都是「颜色很奇怪」：

| 用在哪 | 对不对 |
|---|---|
| 登录页那行品牌眉标、头像底 | ✅ **品牌陈述** |
| 未读数的**值**（`1 条未读`）、通知列表的未读**圆点** | ✅ **状态** |
| 错误文案、`DangerRow`（退出登录） | ✅ **语义** |
| 行左侧的**图标**按未读数染主色 | ❌ 一排灰图标里蹦出一个紫的，很突兀。`RowIcon` 现在**没有**高亮这个口子 |
| 通知的**分类**标签染主色 | ❌ 把「状态」和「分类」两回事混在一起了 |
| 分区抬头（`GroupHeader`） | ❌ 全屏最艳的东西成了俩静态标签 |

一句话：**状态要表达就表达在「值」上，不要动图标、标签、抬头。**

⚠️ 破坏性动作用 `DangerRow` —— iOS 上就是**居中的红字，没有图标**。
加过一版带图标的，图标和文字两块红还不同调，一眼就怪。
红色取 iOS 的 systemRed（`#FF3B30` / 深色 `#FF453A`），之前用的 `#E5484D` 偏粉。

⚠️ 未读红点挂在**首页**那个 tab 上，因为通知的入口就在那一屏。
挂到「我的」上过一版 —— 点进去找不到通知，语义不对。

### 分组列表的三个薄封装

`src/components/grouped.tsx`：`GroupHeader` / `Group` / `Row` / `PressRow` /
`Chevron` / `RowIcon`。里面全是 rnr 的原语 + 令牌类名 —— **不是另起一套设计系统**，
分组列表只是不在 rnr 的清单里。

🔴 **分隔线画在「非首行」的顶部，而且左边内缩到内容起点。**
RN 没有 `:last-child`，`first` 要显式传；通栏的分隔线会把分组块切成一格一格，
内缩之后它才读作「同一块里的下一行」。有图标的行内缩量要加上图标宽 + 间距
（`inset={56}`）。

⚠️ **输入框长在分组块的行里**，不是一个个描边盒子 —— iOS 表单就是这个形状。
写法是给 `Input` 加 `className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"`
把 rnr 的盒子样式卸掉。

### 品牌头 `src/components/brand-top.tsx`

顶部一块淡紫渐变（`expo-linear-gradient`，在 Expo Go 自带清单里），收着榫卯标记 +
wordmark。**这是全 App 唯一的品牌表达：不铺满、不饱和。**

🔴 渐变的落点必须是**页面底色本身**（`--color-background`），不是白色 ——
不然渐变结束处会有一道可见的接缝。⚠️ 深色下不叠紫：纯黑上叠紫会显脏，
而且分组块本身已经把层级说清楚了。

### CLI 装完要补的两处

- `src/components/ui/input.tsx` 解构了 `placeholderClassName`，但 `TextInputProps`
  里没有这个键，TS 6 下报错。**补一条可选声明，不要把解构删掉** —— 删了它会被
  透传到原生 `TextInput`
- `add` 对**已存在的同名文件默认跳过**（提示 `files might be identical`）。
  自己先写过一版同名组件的话要么 `--overwrite`、要么先删 —— 不然装了等于没装
  （实测：`checkbox` 装了两次都还是我那个旧的）

### 排版

- iOS 大标题 `text-3xl font-bold` + `letterSpacing: -0.9`
- 行内文字 15、值 14、说明 12、等宽标注 10–11
- 行高 `min-h-[46px]`，主按钮 `h-[50px] rounded-xl`
- 等宽字（JetBrains Mono）只给**数据**：ID、时区、用户名、时间戳
- 🔴 **字没载完之前 `_layout` 直接 `return null`。** RN 里 `fontFamily` 指向一个
  还没注册的字族是**静默回落到系统字体**的（不报错），首帧会明显抖一下
- ⚠️ `tracking` 在 RN 里是 `letterSpacing`（**绝对 px**），不是 em

### 导航容器要自己上色

tab 栏和 Stack header 都设成 `--color-card` + `hairlineWidth` 边（不是 1 ——
1px 在高密度屏上是两三个物理像素）。不设的话是系统默认白，和 grouped background
之间有一道生硬的接缝。三个 tab 屏都自带品牌头，所以它们的 header 全关掉了。

⚠️ 这些是**原生组件的 prop，不吃 `className`**，颜色只能从 `useCSSVariable` 取；
写死 hex 的话深浅色主题里必有一头是错的。

### 品牌图形

`src/components/tenon-mark.tsx` 是 `apps/web/src/components/tenon-mark.tsx` 的
RN 版，**路径逐字一致**。⚠️ web 那份用 `currentColor`，`react-native-svg` **不认**
（没有 CSS 继承），颜色走 `color` prop 显式传。

图标由 `scripts/gen-brand-icons.mjs` 生成（`pnpm brand:icons`），**不要手放图**：

| 文件 | 形状 | 为什么 |
|---|---|---|
| `icon.png` | 满幅方形、**不透明** | iOS 自己会圆角裁切；给带透明圆角的图，那几个角在 iOS 上会变成**黑色** |
| `adaptive-icon.png` | **透明底、墨迹缩到安全区内** | Android 用系统蒙版裁前景层，外圈约 1/3 一定被切掉 |
| `splash.png` | 圆形徽章、透明底 | 配 `app.json` 里的浅/深背景色 |

⚠️ **在 Expo Go 里，桌面图标和任务切换器显示的永远是 Expo Go 自己的** ——
App 跑在它里面。`app.json` 的 `name` 和这套图标只在启动画面、Expo Go 的项目卡片、
dev menu 里生效。要让桌面上真出现，必须打独立 APK。

### 登录方式：三个页签，后两个是诚实的占位

和 web 端 `_guest/sign-in.tsx` 的 `METHODS` 一一对应：密码 / 手机 / 扫码。
后两个走 `NotWired`：**说清楚为什么不能用，并把人送回能用的那条** ——
光禁用一个页签只会让人反复去点它。

⚠️ 三个页签的内容区要 `minHeight` 对齐，否则切换时下面的东西会跳。

## 🔴 占位符颜色只能走 `placeholderTextColor`

Tailwind 的 `placeholder:*` 是 CSS 伪元素变体，RN 里没有这个概念 ——
写了不报错也不生效。不给的话各 Android 版本的默认占位色不一样，深色主题下经常
糊成一片看不见，而这**不会报任何错**。`components/ui/input.tsx` 用
`useCSSVariable('--color-muted-foreground')` 取值再传给这个 prop。

## 反馈：`toast` 管写操作，屏内错误块管拉取 —— 别混用

硬纪律 9 说「请求失败必须是可见状态」，但**可见的形式有两种**，混用哪一种都会坏：

| | 用什么 | 为什么 |
|---|---|---|
| **拉取**失败（列表 / 详情 / 权限码） | 屏内 `Alert` + 重试按钮 | 那块内容本来就没有，错误要**占住它的位置**。toast 飘走之后屏上是一片空，和「没有数据」分不清 |
| **写**失败（删除 / 保存） | `toast.error()` | 屏上内容还是对的（删除失败 = 那条还在），没有位置可占；而且写操作常常 `router.back()`，屏内提示跟着卸载**等于没报** |

web 那边是同一个分工（拉取走 `QueryError`、mutation 走全局 toast，见 #51）。
移动端在 `ui/toast.tsx` 之前**只有前一半**，于是三个屏各写了一段 inline 错误，
而删除类操作一个都没有 —— 因为没地方报。

`toast.success/error/info/warning/message/dismiss` 与 `packages/ui` 的
[toast](../../../../packages/ui/src/components/toast.tsx) **同名同形**（抄形状不抄实现）。
**没有** `loading` / `promise` / `update` —— 那三个是给「长任务原地变结果态」用的，
这一版没有那种场景。

🔴 **命令式 API 的状态必须在模块级 store 里**（`useSyncExternalStore` 订阅），
不能做成 context + hook —— mutation 的 `onError` 在 React 之外，拿不到 hook。

🔴 **`emit()` 里必须换数组引用**（`items = [...items]`）。`useSyncExternalStore`
用 `Object.is` 比快照，原地 `push` 的话订阅者**一次都不会重渲染** ——
toast 进了 store、屏上没有，纯静默。

⚠️ 三个和 web 刻意不同的地方：

- **错误 toast 不自动消失**（同 web），但**必须给退出口** —— 手机上一条不会走的
  横幅会一直压着内容，而没有 hover 这回事。所以整条可点掉、右侧有一枚 ✕
- **同时最多 3 条**：屏窄，第 4 条一来最早那条就该走，否则能盖掉半屏
- 非错误的 timeout 是 **3.5s**（web 是 4.5s）：它压在内容上

🔴 **`Toaster` 只能挂一个**（根 `_layout.tsx` 里、`<PortalHost />` **之后**）。
挂两个每条 toast 会显示两遍。

🔴 **容器要 `pointerEvents="box-none"`。** 它绝对定位铺满整屏，不写这一句会吃掉
**整屏**的触摸 —— 而且只在有 toast 的那几秒里发生，和「界面卡住」很难区分。

## 确认框走 portal，不走 `Modal` —— 代价是返回键要自己接

`ui/confirm-dialog.tsx` 的 props 形状照 `packages/ui` 的
[confirm-dialog](../../../../packages/ui/src/components/confirm-dialog.tsx) 抄
（`open` / `onOpenChange` / `title` / `description` / `confirmLabel` /
`cancelLabel` / `variant` / `onConfirm`），多一个 `busy`（确认后的请求还在飞）。

**为什么不用 RN 的 `Modal`**：它把内容挂到**另一个原生根视图**上。uniwind 的令牌
解析发生在 React 里，理论上跨 `Modal` 也成立 —— 但这台机器上**没有能跑起来的设备**
（模拟器还卡在 kvm 组），而「样式在另一个原生根上失效」这一类问题
**打包和 typecheck 全都不报**。所以选了已经在用的那条路：`@rn-primitives/portal`
渲染进根 layout 的 `<PortalHost />`，**同一棵 React 树、同一个原生根**。

⚠️ **这是一个「此刻无法验证」下的选择，不是结论。** 等设备能跑起来了要实测一次
再决定要不要换 `Modal` —— 别因为「Modal 更标准」就换过去。

🔴 **走 portal 的浮层必须自己接 Android 返回键**（`BackHandler`）。在原生看来它
只是一层普通 View，返回键**不会关它** —— 会直接把当前屏 pop 掉，于是「按返回」=
确认框还开着、底下的屏却退了。`Modal` 的 `onRequestClose` 白送这一条，portal 没有。
`busy` 时也要返回 `true`（吃掉返回键），否则请求在飞、屏被退掉。

## 🔴 `Group` 和虚拟化列表冲突

`grouped.tsx` 的 `Group` 是一个 `Card` 包住所有行、行间画内缩分隔线 —— 那个形状
**只适合定长列表**（设置屏、详情页的资料块）。`FlatList` 只挂载可见的那几行，
包不住一个跨全表的圆角容器，滚动时上下边缘的圆角会跟着行进出而闪。

**要翻页的列表用独立卡片**（每条一个 `Card`，`contentContainerClassName` 里给
`gap-2.5`），见 `src/app/(app)/users/index.tsx`。

## 🔴 `active:` 只在 uniwind 的 `Pressable` 里解析 —— 挂在别的组件上是死代码

写过 `<Pressable><Card className="active:bg-muted …">`，那个 `active:`
**一次都不会生效**：按下去没有任何反应，而且**不报错、不警告**。

根因在 uniwind 的组件包装里，读了实现：

| 包装 | 怎么算样式 |
|---|---|
| uniwind 的 Pressable 包装 | `style` 传成**函数**，`state.pressed` 时带 `isPressed` 重算 |
| uniwind 的 View 包装（`Card` / `Group` / `Row` 都是 View） | 只有 `useStyle(className, props)`，**压根没有 pressed 这一维** |

（两个文件在 `node_modules/…/uniwind/dist/module/components/native/` 下，
要复核就去读那一对。）

所以规则是：**`active:` 必须写在那个 `Pressable` 自己的 `className` 上。**
仓库里其余几处都是对的（`grouped.tsx` 的 `PressRow` / `DangerRow`、通知列表那一行），
只有列表行那次写错了 —— 因为想复用 `Card` 的卡片表面。
**要卡片表面就让 `Pressable` 自己画**（`bg-card active:bg-muted rounded-xl`），
别套一层 `Card` 再往里挂 `active:`。

## 🔴 portal 浮层的 `name` 要每实例唯一

`@rn-primitives/portal` 的宿主**按 name 存内容**，两个同名浮层会互相顶掉。
`ConfirmDialog` 用 `confirm-dialog-${React.useId()}`。

写死一个字面量在「同时只可能开一个」的假设下能跑 —— 但那个假设是隐式的，
而现在已经有两屏各挂一个（个人中心的退出登录、用户详情的删除），
且 tab 屏在详情推上来之后**仍然挂载**。

## 🔴 标签列用 `min-w-*`，不要用 `w-*` —— 写死宽度在英文下必然换行

表单行是「固定宽度的标签 + `flex-1` 的输入框」。宽度是照中文调的
（`w-[62px]` 刚好放下「用户名」3 个字并保持各行对齐），而**英文放不下**：
实测截图里登录屏是 `Usernam` / `e`、`Passwor` / `d` 断成两行。

**中文开发看不到这个** —— 只有把设备语言切成英文才现形，而两种语言下都不报错。

`min-w-*` 两头都对：中文下所有标签仍然是同一个宽度（对齐不变），
英文下按自身内容撑开、不换行，输入框跟着让位。

已改的三处：`login.tsx`（4 处）· `profile/edit.tsx`（2 处）· `profile/password.tsx`。
**新写表单行时直接用 `min-w-*`。**

