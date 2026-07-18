import * as React from 'react'


/**
 * 平台运行时上下文 —— 由 app 注入它自己才知道的东西。
 *
 * `packages/platform` 不认识 `apps/web` 的 routeTree，
 * 但菜单管理需要「前端真实存在的路由列表」来把 path 做成下拉选择
 * （而不是自由输入）—— 那样连填错的机会都没有，Vue 那套
 * 「菜单配错组件路径导致白屏」在这里从根上不可能发生。
 */
export type PlatformContextValue = {
  /** 前端真实存在的路由 path，已排序 */
  validPaths: string[]
  isValidPath: (path: string) => boolean
}

const Ctx = React.createContext<PlatformContextValue>({
  validPaths: [],
  isValidPath: () => true,
})

export function PlatformProvider({
  value,
  children,
}: {
  value: PlatformContextValue
  children: React.ReactNode
}) {
  // 偏好的落地点已上移到应用根（apps/web/src/app.tsx）——
  // 这里只包住登录后的外壳，挂在这里会让登录页不跟随主题
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlatform() {
  return React.useContext(Ctx)
}
