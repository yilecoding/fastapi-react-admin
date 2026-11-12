import { create } from 'zustand'

/**
 * 外壳导览和「别的全屏浮层」之间的让行规则（#190 登录后弹窗）。
 *
 * 导览不自动弹（2026-11 去掉了首登自动启动），只有人自己从顶栏「帮助」/ ⌘K 点开。
 * 剩下的冲突只有一个方向：导览正在跑时，socket 推来一条要弹的公告 —— 弹窗是 modal Dialog，
 * 打开时把外面的东西都设成不可交互，driver.js 的气泡挂在 `<body>` 下，「下一步」点不动；
 * 反过来导览的遮罩又盖住弹窗的「我已阅读」。所以新到的弹窗**先等导览结束**（`useTourActive()`）。
 *
 * 放在 `shell/` 而不是 `pages/notice/`：导览是外壳的东西，`shell` 不能 import 页面
 * （那条反向依赖只留给 `use-sidebar → dev-sandbox`），只能由页面那一侧来看它的状态。
 */
type GateState = {
  /** driver.js 正在跑 */
  active: boolean
}

const useGate = create<GateState>(() => ({ active: false }))

/** 导览正在跑没有（弹窗那边据此先等一等） */
export function useTourActive(): boolean {
  return useGate((s) => s.active)
}

/** 只给 `tour.ts` 用：启动 / 销毁时各报一次 */
export function setTourActive(active: boolean): void {
  useGate.setState({ active })
}
