import { NoticesCard } from './notices'
import { QuickLinksCard } from './quick-links'
import { LoginTrendCard, MetricsCard, RecentLoginsCard, RecentOperasCard } from './stats'
import { TodoCard } from './todo'
import type { DashboardCardDef } from './types'
import { UnreadCard } from './unread'

/**
 * 工作台卡片注册表（#202）。**顺序就是默认布局的顺序**：
 * 普通员工默认「快捷入口 · 我的待办 · 未读消息 · 公告」，有日志 / 用户权限的人在这之后再接统计卡。
 *
 * 加一张卡片 = 这里加一项 + `cards/` 下一个内容组件（外壳一律用 `card-shell.tsx`）。
 * 已经存过布局的人会在最后看到它（按 `defaultVisible`），不用迁移任何人的数据。
 *
 * 🔴 `id` 存在每个人的布局里，发出去之后不能改（见 `DashboardCardDef` 的注释）。
 */
export const DASHBOARD_CARDS: readonly DashboardCardDef[] = [
  {
    id: 'quick-links',
    title: (t) => t('快捷入口'),
    // 候选来自这个人自己的侧边栏，人人都有
    available: () => true,
    defaultWidth: 'full',
    defaultVisible: true,
    Component: QuickLinksCard,
  },
  {
    id: 'todo',
    title: (t) => t('我的待办'),
    // 接口只要登录（`/sys/workflow/inbox/*`），但审批是插件：没装 / 菜单没授权给他时侧边栏里没有审批中心，
    // 这张卡片取数必然 404 / 点「全部」也进不去 —— 跟着侧边栏走
    available: (c) => c.inSidebar('/workflow/inbox'),
    defaultWidth: 'half',
    defaultVisible: true,
    Component: TodoCard,
  },
  {
    id: 'unread',
    title: (t) => t('未读消息'),
    // 和顶栏铃铛同一个数据源，铃铛人人都有
    available: () => true,
    defaultWidth: 'half',
    defaultVisible: true,
    Component: UnreadCard,
  },
  {
    id: 'notices',
    title: (t) => t('公告'),
    // `/sys/notices/feed` 只要登录（#186）
    available: () => true,
    defaultWidth: 'full',
    defaultVisible: true,
    Component: NoticesCard,
  },
  {
    id: 'metrics',
    title: (t) => t('今日指标'),
    // 任一格有权限就有这张卡；没权限的格子在卡片里不画
    available: (c) => c.canAny('log:login:list', 'log:opera:list', 'sys:user:list'),
    defaultWidth: 'full',
    defaultVisible: true,
    Component: MetricsCard,
  },
  {
    id: 'login-trend',
    title: (t) => t('近 7 天登录'),
    available: (c) => c.can('log:login:list'),
    defaultWidth: 'full',
    defaultVisible: true,
    Component: LoginTrendCard,
  },
  {
    id: 'recent-logins',
    title: (t) => t('最近登录'),
    available: (c) => c.can('log:login:list'),
    defaultWidth: 'half',
    defaultVisible: true,
    Component: RecentLoginsCard,
  },
  {
    id: 'recent-operas',
    title: (t) => t('最近操作'),
    available: (c) => c.can('log:opera:list'),
    defaultWidth: 'half',
    defaultVisible: true,
    Component: RecentOperasCard,
  },
]
