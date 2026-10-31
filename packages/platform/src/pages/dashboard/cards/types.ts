import type { ComponentType } from 'react'

import type { CardDefault } from '../layout'
import type { NavNode } from '../../../shell/use-sidebar'

/** 普通函数里用的 `t` 签名（i18n 分册第 5 条：不能在普通函数里调 hook，把 `t` 传进来） */
export type TFn = (key: string, vars?: Record<string, unknown>) => string

/** 卡片判断「这个人能不能用我」时拿得到的东西 */
export type CardContext = {
  /** 全部满足 / 任一满足（超管恒真）—— 就是 `usePerm()` 的那两个，不另写一份判定 */
  can: (...perms: string[]) => boolean
  canAny: (...perms: string[]) => boolean
  /** 这个人自己的侧边栏里有没有这个页面（菜单没授权 / 插件没装就没有） */
  inSidebar: (path: string) => boolean
}

/** 页面交给每张卡片的东西 —— 卡片不读路由（硬纪律 1），开抽屉一律经页面写自己的 search */
export type CardProps = {
  /** 就地打开一条公告（读者抽屉） */
  openNotice: (noticeId: string) => void
  /** 就地打开一张审批单（详情抽屉） */
  openApproval: (instanceId: string) => void
  /** 快捷入口挑了哪些页面；`null` = 没挑过 */
  quickLinks: string[] | null
  /** 当前用户侧边栏里能去的页面（快捷入口的候选） */
  pages: NavNode[]
}

/**
 * 卡片注册表里的一项：id · 标题 · 能不能用（权限） · 默认宽度 · 默认显隐 · 组件。
 *
 * 🔴 `id` 一旦发出去就不能改 —— 它存在每个人的布局里（`dashboard.layout`）。改名 = 所有人这张卡片的
 * 设置作废、退回默认值排到最后（`resolveLayout` 的兼容规则），不会报错
 */
export type DashboardCardDef = CardDefault & {
  /** 标题。写成函数是为了让 `t('…')` 保持字面量（i18n 校验器只认字面量） */
  title: (t: TFn) => string
  /**
   * 能不能用。**不能用的卡片不进候选也不渲染** —— 不再摆一张「没有权限」（#202）。
   * 判据要和这张卡片取数的接口守卫一致：判宽了是一张必然 403 的卡片，判窄了是有权限的人看不到
   */
  available: (ctx: CardContext) => boolean
  Component: ComponentType<CardProps>
}
