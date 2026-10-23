import * as React from 'react'

/**
 * 「用户多少秒没操作了」—— 每个请求带成 `X-Client-Idle`（#138）。
 *
 * 服务端的空闲超时按**人有没有在操作**算，不按请求算：在线用户页 10 秒轮询一次、监控页、
 * 审批的 AI 预审、导出任务都在后台发请求，按请求算的话人走开了会话也永远不过期 ——
 * 等保要防的「人离开、浏览器开着」正是这个场景。后台请求带着很大的空闲秒数，
 * 服务端就不拿它续活跃。
 *
 * 只记「这个标签页」的操作：几个标签页各报各的，服务端取最近的那次（只往后挪）。
 */
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

let lastActive = Date.now()
let installed = false

export function clientIdleSeconds(): number {
  return Math.max(0, Math.floor((Date.now() - lastActive) / 1000))
}

/** 装一次就够（模块级，同 `installVersionWatch`）。没装的时候 `clientIdleSeconds` 一直从加载时刻算 */
export function installActivityTracker(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const mark = () => {
    lastActive = Date.now()
  }
  // capture：scroll 不冒泡，挂在 window 的捕获阶段才收得到任意容器里的滚动
  for (const name of EVENTS) window.addEventListener(name, mark, { passive: true, capture: true })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') mark()
  })
}

/** 心跳间隔。远小于最短的空闲上限（参数配置的下界是 5 分钟） */
export const HEARTBEAT_MS = 5 * 60_000

/**
 * 有操作就每 5 分钟打一次 `POST /auth/heartbeat`。
 *
 * 🔴 服务端判空闲只看**记录下来的**最后活跃（自报的「0 秒没操作」不能把一个已经空闲过头的会话
 * 续上），而记录只在请求到达时更新。读一份长文档、两小时没发请求的人，没有心跳的话下一次点击
 * 就会被当成空闲踢出去。最近 5 分钟没操作就不发 —— 那正是要让它过期的情形
 *
 * @param send 发心跳（失败静默：401 会照常走刷新 / 收尾，网络抖一下下一轮再说）
 */
export function useSessionHeartbeat(send: () => Promise<unknown>): void {
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (clientIdleSeconds() * 1000 < HEARTBEAT_MS) void send().catch(() => undefined)
    }, HEARTBEAT_MS)
    return () => clearInterval(timer)
  }, [send])
}
