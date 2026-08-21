"use client"

import * as React from "react"

import { type GridDensity } from "./density"

/**
 * 表格的**外观偏好**（密度 / 斑马纹 / 边框）。
 *
 * 和「数据视图状态」（筛选、分页、选中）分开：那些必须进 URL 才能跨刷新恢复，
 * 而外观是**用户的个人习惯**，跟着人走而不是跟着链接走 —— 所以落 localStorage。
 * 传 `storageKey` 就按表持久化，不传就是纯组件内 state。
 */
export type GridView = {
  density: GridDensity
  striped: boolean
  bordered: boolean
}

const DEFAULTS: GridView = { density: "standard", striped: false, bordered: true }

function read(key: string): Partial<GridView> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Partial<GridView>) : null
  } catch {
    return null
  }
}

export function useGridView(storageKey?: string, initial?: Partial<GridView>) {
  // ⚠️ 不能直接 `{...DEFAULTS, ...initial}`：调用方不传 defaultDensity 时
  // initial 是 `{density: undefined}`，展开会把默认值**覆盖成 undefined**，
  // 后面 `GRID_DENSITY[undefined].head` 直接抛。显式过滤掉 undefined。
  const base = React.useMemo(() => {
    const defined = Object.fromEntries(
      Object.entries(initial ?? {}).filter(([, v]) => v !== undefined)
    ) as Partial<GridView>
    return { ...DEFAULTS, ...defined }
  }, [initial?.density, initial?.striped, initial?.bordered])
  const [view, setView] = React.useState<GridView>(base)

  // 调用方后来改了默认值（组件沙箱的旋钮就是这么用的）要跟着变。
  // 首次跳过：否则会和下面的 localStorage 回填抢，把用户存的偏好冲掉。
  const mounted = React.useRef(false)
  React.useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    setView(base)
  }, [base])

  // 读 localStorage 放在 effect 里而不是 useState 初始值：
  // 初始值里读会让 SSR/首屏和水合后的 DOM 不一致
  React.useEffect(() => {
    if (!storageKey) return
    const saved = read(storageKey)
    if (saved) setView((v) => ({ ...v, ...saved }))
  }, [storageKey])

  const patch = React.useCallback(
    (next: Partial<GridView>) => {
      setView((v) => {
        const merged = { ...v, ...next }
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(merged))
          } catch {
            /* 隐私模式下写不了，内存态照常生效 */
          }
        }
        return merged
      })
    },
    [storageKey]
  )

  return [view, patch] as const
}
