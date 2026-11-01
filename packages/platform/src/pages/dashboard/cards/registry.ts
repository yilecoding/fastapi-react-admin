import { AttentionCard } from './attention'
import { InitiatedCard } from './initiated'
import { NoticesCard } from './notices'
import { QuickLinksCard } from './quick-links'
import { QuickStartCard } from './quick-start'
import { ServicesCard } from './services'
import { TodoCard } from './todo'
import type { DashboardCardDef } from './types'
import { UnreadCard } from './unread'
import { VisitsCard } from './visits'

/** 审批是插件：没装 / 菜单没授权给他时侧边栏里没有审批中心，取数必然 404、「全部」也进不去 —— 跟着侧边栏走 */
const hasWorkflow = (c: Parameters<DashboardCardDef['available']>[0]) => c.inSidebar('/workflow/inbox')

/**
 * 工作台卡片注册表（#202）。**组内顺序就是默认布局的顺序**，两组各排各的（`group`）：
 *
 * - `work`：每个人的 —— 待我处理（最显眼，占三分之二）· 我发起的 · 快速发起 · 常用入口 · 和我有关的消息。
 *   公告默认**不显示**（顶栏横幅 / 弹窗 / 铃铛已经覆盖了「有新公告」），在「自定义」里能打开
 * - `system`：「系统运行」区，有对应管理权限的人才有 —— 需要你留意 · 服务状态 · 近 14 天访问
 *
 * 加一张卡片 = 这里加一项 + `cards/` 下一个内容组件（外壳一律用 `card-shell.tsx`）。
 * 已经存过布局的人会在最后看到它（按 `defaultVisible`），不用迁移任何人的数据。
 *
 * 🔴 `id` 存在每个人的布局里，发出去之后不能改（见 `DashboardCardDef` 的注释）。
 * 「和我有关的消息」「常用入口」沿用了第一期的 `unread` / `quick-links`，存过的布局照认
 */
export const DASHBOARD_CARDS: readonly DashboardCardDef[] = [
  {
    id: 'todo',
    group: 'work',
    title: (t) => t('待我处理'),
    available: hasWorkflow,
    defaultWidth: 'two-thirds',
    defaultVisible: true,
    Component: TodoCard,
  },
  {
    id: 'initiated',
    group: 'work',
    title: (t) => t('我发起的'),
    available: hasWorkflow,
    defaultWidth: 'third',
    defaultVisible: true,
    Component: InitiatedCard,
  },
  {
    id: 'quick-start',
    group: 'work',
    title: (t) => t('快速发起'),
    available: hasWorkflow,
    defaultWidth: 'third',
    defaultVisible: true,
    Component: QuickStartCard,
  },
  {
    id: 'quick-links',
    group: 'work',
    title: (t) => t('常用入口'),
    // 候选来自这个人自己的侧边栏，人人都有
    available: () => true,
    defaultWidth: 'third',
    defaultVisible: true,
    Component: QuickLinksCard,
  },
  {
    id: 'unread',
    group: 'work',
    title: (t) => t('和我有关的消息'),
    // 和顶栏铃铛同一个数据源，铃铛人人都有
    available: () => true,
    defaultWidth: 'third',
    defaultVisible: true,
    Component: UnreadCard,
  },
  {
    id: 'notices',
    group: 'work',
    title: (t) => t('公告'),
    // `/sys/notices/feed` 只要登录（#186）
    available: () => true,
    defaultWidth: 'full',
    defaultVisible: false,
    Component: NoticesCard,
  },
  {
    id: 'attention',
    group: 'system',
    title: (t) => t('需要你留意'),
    // 三个来源各要各的权限，后端逐条过滤；任一来源看得见就有这张卡（判据和 `dashboard_service.attention` 同一份）
    available: (c) => c.canAny('open:webhook:list', 'task:scheduler:edit', 'log:login:list'),
    defaultWidth: 'half',
    defaultVisible: true,
    Component: AttentionCard,
  },
  {
    id: 'services',
    group: 'system',
    title: (t) => t('服务状态'),
    // 接口是 `DependsSuperUser`（同服务器监控），没有权限码可判
    available: (c) => c.isSuperuser,
    defaultWidth: 'half',
    defaultVisible: true,
    Component: ServicesCard,
  },
  {
    id: 'visits',
    group: 'system',
    title: (t) => t('近 14 天访问'),
    available: (c) => c.can('log:login:list'),
    defaultWidth: 'full',
    defaultVisible: true,
    Component: VisitsCard,
  },
]
