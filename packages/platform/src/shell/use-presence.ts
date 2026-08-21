import * as React from 'react'
import { io, type Socket } from 'socket.io-client'

import { API_BASE } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'

/**
 * 在线状态上报。
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
 *   - `auth` 里要 `{ token, session_uuid }`，缺一个后端直接拒绝握手
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
    const token = tokenStore.get()
    const sessionUuid = tokenStore.getSessionUuid()
    // 老会话（本次改动之前登录的）没存 session_uuid —— 不上报，等下次登录自然就有了
    if (!token || !sessionUuid) return

    let socket: Socket | null = null
    try {
      // 注意是 API_BASE 本身（默认命名空间 `/`），不要拼 `/ws` —— 见上面的注释
      socket = io(API_BASE, {
        path: '/ws/socket.io',
        transports: ['websocket', 'polling'],
        auth: { token, session_uuid: sessionUuid },
        // 后端拒绝握手时不要无限重试打后端
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30_000,
        withCredentials: true,
      })

      socket.on('connect_error', (err) => {
        if (import.meta.env?.DEV && !warned.current) {
          warned.current = true
          console.warn(
            `[presence] 在线状态上报未建立（${err.message}）。` +
              '「在线用户」页的实时连接列会显示离线，其余功能不受影响。'
          )
        }
      })
    } catch {
      /* 构造失败（极少见）同样静默 —— 这是可选能力 */
      return
    }

    return () => {
      socket?.removeAllListeners()
      socket?.disconnect()
    }
  }, [enabled])
}
