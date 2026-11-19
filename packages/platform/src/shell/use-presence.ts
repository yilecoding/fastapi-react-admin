import * as React from 'react'
import { io, type Socket } from 'socket.io-client'
import { toast } from '@admin/ui/components/toast'

import { API_BASE, endSession, restoreSession } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'
import { handleSessionEnded, isEndingLocally } from '../auth/session'
import { dispatchSocketEvent } from './socket-events'

/**
 * 在线状态上报 **+ 服务端推送的接收端**。
 *
 * 「在线用户」页的「实时连接」列读的是 Redis 里的 `fba:token_online` 集合，
 * 而那个集合**只有 socket.io 的 connect/disconnect 事件会写**
 * （见后端 `common/socketio/server.py`）。没有这个连接，那一列永远是「离线」——
 * 一个装饰性的假状态。这个 hook 就是把它变成真的。
 *
 * 连接参数必须和后端对齐：
 *   - 挂载点 `app.mount('/ws', socket_app)` + `socketio_path='/ws/socket.io'`
 *     → 客户端 `path` 要写全 `/ws/socket.io`
 *   - **命名空间是 `/` 而不是 `/ws`**。后端 `AsyncServer(namespaces=['/ws'])` 很有误导性：
 *     那个参数只是「额外接受哪些命名空间」，而 `@sio.event` 注册的 connect/disconnect
 *     处理器绑在**默认命名空间 `/`** 上。连到 `/ws` 会握手成功但**不执行任何处理器** ——
 *     Redis 里的 `fba:token_online` 一个都不写，页面上全是「离线」，且日志里
 *     看得到 `WebSocket ... [accepted]`，非常难查。实测：连 `/` 时 SCARD 1，连 `/ws` 时 0
 *   - `auth` 里要 `token`。🔴 **写成函数，不能写成对象**：socket.io 每次（重）连都调一遍这个函数，
 *     写成对象的话断线重连带的永远是建连那一刻的 token —— 而它只活 30 分钟（#138），
 *     半小时后任何一次断线重连都握不上手。会话 ID 后端从 token 里自己解，不再信这里报的
 *
 * ── 它同时是这条连接上所有推送的唯一入口 ──
 *
 * 🔴 **不要为了收某个事件再 `io()` 一条连接。** 后端 `connect` 每建立一条连接就往
 * `fba:token_online` 里记一次，第二条会把「在线用户」页的会话数直接翻倍 ——
 * 而那个页面的数字看起来仍然像真的。所有事件都从这一条进来，
 * 转手交给 `socket-events.ts` 广播给订阅方。
 *
 * `onAny` 而不是逐个 `.on()`：新增一种服务端事件时这里一行都不用改，
 * 也就不会出现「后端发了、前端谁也没接」那种死代码
 * （`task_notification` 就这么当了很久的死代码）。
 *
 * 设计上刻意「安静」：
 *   - 连不上不弹错、不刷控制台 —— 它只是个状态上报，挂了不该影响任何业务功能
 *   - 只在 DEV 且首次失败时打一条 warn
 *   - 组件卸载即断开（登出、切账号都会走到这里）
 */
export function usePresence(enabled: boolean) {
  const warned = React.useRef(false)

  React.useEffect(() => {
    if (!enabled) return
    if (!tokenStore.get()) return

    let disposed = false
    let recovering = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 2000
    let socket: Socket | null = null

    const clearRetry = () => {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    const scheduleRecovery = () => {
      if (
        disposed ||
        recovering ||
        retryTimer !== undefined ||
        !tokenStore.get()
      )
        return
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void recover()
      }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
    const recover = async () => {
      // Transport failures are already retried by the Manager. A rejected
      // namespace handshake destroys that subscription and needs explicit recovery.
      if (
        disposed ||
        recovering ||
        !socket ||
        socket.connected ||
        socket.active ||
        !tokenStore.get()
      )
        return
      // 本标签页正在登出：服务端撤销会话时先断了 socket，这时去刷新只会拿到 ended、抢在登出响应之前
      // 收尾跳登录页（#374）。让路但不放弃 —— 登出成功会清 token，下一轮自然停；登出失败就照常恢复
      if (isEndingLocally()) {
        scheduleRecovery()
        return
      }
      recovering = true
      const before = tokenStore.get()
      try {
        const outcome = await restoreSession()
        if (disposed) return
        if (outcome.kind === 'ok') {
          socket.connect()
        } else if (outcome.kind === 'ended') {
          // Do not end a newer login while an older refresh was in flight.
          if (isEndingLocally()) {
            // 登出还没落地：交给登出收尾；万一登出失败（仍是登录态），下一轮照常恢复
            recovering = false
            scheduleRecovery()
          } else if (tokenStore.get() === before) endSession(outcome.end)
        } else {
          recovering = false
          scheduleRecovery()
        }
      } finally {
        recovering = false
      }
    }

    const resume = () => {
      if (document.visibilityState === 'hidden' || socket?.connected) return
      // Respect an existing backoff, including bursts of online/visibility events.
      scheduleRecovery()
    }

    try {
      // 注意是 API_BASE 本身（默认命名空间 `/`），不要拼 `/ws` —— 见上面的注释
      socket = io(API_BASE, {
        path: '/ws/socket.io',
        transports: ['websocket', 'polling'],
        auth: (cb) => cb({ token: tokenStore.get() }),
        // 服务端长时间停机后仍要恢复；握手拒绝由下面的退避刷新单独处理。
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30_000,
        withCredentials: true,
      })

      // 任务执行事件 → 瞬时 toast。**刻意不落库**：任务的「上次几点跑的、
      // 失败在哪一行」永远看执行记录页（`task_result` 表），这条只是实时提示。
      // 文案由后端拼好（永远是中文，见 `app/task/tasks/base.py` 的注释）。
      socket.on('task_notification', (payload: { msg?: string }) => {
        if (payload?.msg) toast.message(payload.msg)
      })

      // 会话结束（被踢 / 被挤掉 / 空闲 / 同一个浏览器的另一个标签页登出了 …，#138）：
      // 不等下一次请求撞上 401 才发现。服务端推完就断开这条连接
      socket.on('session:ended', (payload: { reason?: string }) => {
        void handleSessionEnded(payload?.reason ?? null)
      })

      // 其余事件一律转给订阅方（铃铛在听 `notification:new`）
      socket.onAny((event: string, payload: unknown) => {
        if (event === 'task_notification' || event === 'session:ended') return
        dispatchSocketEvent(event, payload)
      })

      // 连接状态挂到 <html> 上：E2E 要等 socket 连上再去踢人 / 登出，否则那条推送会落空、
      // 用例只能靠猜一个毫秒数（e2e 分册：不要靠 waitForTimeout）。顺带也方便现场排查
      socket.on('connect', () => {
        clearRetry()
        retryDelay = 2000
        document.documentElement.dataset.presence = 'on'
      })
      socket.on('disconnect', (reason) => {
        document.documentElement.dataset.presence = 'off'
        // A session:ended recovery may have adopted the same user's newer session.
        if (reason === 'io server disconnect') scheduleRecovery()
      })

      socket.on('connect_error', (err) => {
        document.documentElement.dataset.presence = 'off'
        if (!socket?.active) scheduleRecovery()
        if (import.meta.env?.DEV && !warned.current) {
          warned.current = true
          console.warn(
            `[presence] 在线状态上报未建立（${err.message}）。` +
              '「在线用户」页的实时连接列会显示离线，其余功能不受影响。'
          )
        }
      })
      window.addEventListener('online', resume)
      document.addEventListener('visibilitychange', resume)
    } catch {
      /* 构造失败（极少见）同样静默 —— 这是可选能力 */
      return
    }

    return () => {
      disposed = true
      clearRetry()
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      socket?.removeAllListeners()
      socket?.offAny()
      socket?.disconnect()
      document.documentElement.dataset.presence = 'off'
    }
  }, [enabled])
}
