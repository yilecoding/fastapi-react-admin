import type { ReactNode } from 'react'

import { usePerm } from './use-perm'

type CanProps = {
  /** 需要的权限码，如 "sys:user:add" */
  perm?: string | string[]
  /** 任一满足即可（默认要求全部满足） */
  any?: boolean
  /** 无权限时的替代内容，默认什么都不渲染 */
  fallback?: ReactNode
  children: ReactNode
}

/**
 * 组件级权限门禁。
 *
 * ```tsx
 * <Can perm="sys:user:add"><Button>新增</Button></Can>
 * <Can perm={['sys:user:edit', 'sys:user:del']} any>…</Can>
 * ```
 *
 * 注意：这只管显隐，**不是安全边界** —— 真正的拦截在后端
 * `common/security/rbac.py: rbac_verify`。
 */
export function Can({ perm, any = false, fallback = null, children }: CanProps) {
  const { can, canAny } = usePerm()
  if (!perm) return <>{children}</>
  const list = Array.isArray(perm) ? perm : [perm]
  const ok = any ? canAny(...list) : can(...list)
  return <>{ok ? children : fallback}</>
}

/**
 * 超管专属门禁 —— 给那些后端挂的是 `DependsSuperUser` 而不是权限码校验的
 * 接口用（用户的新增/编辑/权限与安全/重置密码、插件管理…）。
 *
 * 🔴 别在这类按钮上改用 `<Can perm="...">`：权限码校验的是 `sys_menu.perms`，
 * 而这些接口从头到尾没查过 perms，随便编一个权限码（哪怕种子里凑巧没有、
 * 现在看起来效果一样）都是假的门禁——一旦有人在菜单管理页手工挂了那个
 * 权限码给某个角色，按钮会出现、点了却稳定 403。
 */
export function SuperOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { isSuperuser } = usePerm()
  return <>{isSuperuser ? children : fallback}</>
}
