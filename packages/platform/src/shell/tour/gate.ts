import * as React from 'react'
import { create } from 'zustand'

/**
 * 外壳导览和「别的全屏浮层」之间的让行规则（#190 登录后弹窗）。
 *
 * 两样东西都想在**登录后的第一屏**出现：导览（`tour-autostart.tsx`，首登 800ms 后自动弹）和
 * 公告弹窗（`pages/notice/popup-host.tsx`，外壳一挂上就取）。叠在一起会互相卡死 ——
 * 弹窗是 modal Dialog，打开时把外面的东西都设成不可交互，driver.js 的气泡挂在 `<body>` 下，
 * 「下一步」点不动；反过来导览的遮罩又盖住弹窗的「我已阅读」。
 *
 * 所以约定一个方向：**弹窗先，导览后**（必须确认的公告是业务上的硬要求，导览随时能从「帮助」重看）。
 *
 * - 弹窗那边在「还在取 / 有一条正开着」时按住导览：`useHoldTour('notice-popups', busy)`
 * - 导览自动启动前看 `isTourHeld()`；放开后自动启动的那个 effect 重跑，照常等 800ms 再弹
 * - 反过来：导览正在跑（人自己从「帮助」点开的）时，新到的弹窗先等它结束（`useTourActive()`）
 *
 * 放在 `shell/` 而不是 `pages/notice/`：导览是外壳的东西，`shell` 不能 import 页面
 * （那条反向依赖只留给 `use-sidebar → dev-sandbox`），只能由页面这一侧来按住它。
 */
type GateState = {
  /** 谁按着（key = 调用方给的名字）。用对象不用 Set：zustand 按引用比较，换一个新对象才会通知 */
  holds: Record<string, true>
  /** driver.js 正在跑 */
  active: boolean
}

const useGate = create<GateState>(() => ({ holds: {}, active: false }))

/** `hold` 为真期间按住外壳导览的自动启动。卸载时自动放开 */
export function useHoldTour(key: string, hold: boolean): void {
  React.useEffect(() => {
    if (!hold) return
    useGate.setState((s) => ({ holds: { ...s.holds, [key]: true } }))
    return () => {
      useGate.setState((s) => {
        const next = { ...s.holds }
        delete next[key]
        return { holds: next }
      })
    }
  }, [key, hold])
}

/** 有没有人按着（订阅版，给自动启动的 effect 当依赖） */
export function useTourHeld(): boolean {
  return useGate((s) => Object.keys(s.holds).length > 0)
}

/** 同上，非订阅版：定时器到点那一刻再查一遍 */
export function isTourHeld(): boolean {
  return Object.keys(useGate.getState().holds).length > 0
}

/** 导览正在跑没有（弹窗那边据此先等一等） */
export function useTourActive(): boolean {
  return useGate((s) => s.active)
}

/** 只给 `tour.ts` 用：启动 / 销毁时各报一次 */
export function setTourActive(active: boolean): void {
  useGate.setState({ active })
}
