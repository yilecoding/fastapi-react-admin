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
