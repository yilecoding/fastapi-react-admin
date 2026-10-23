import * as React from 'react'

import { ApiError, isSessionEndReason, type SessionEndReason } from '@admin/api'
import { setDisplayTimeZone } from '@admin/i18n'

import { api, setSessionExpiredHandler } from '@/lib/api'
import type { CurrentUser } from '@/lib/contract'
import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

type Status = 'loading' | 'authed' | 'anonymous'

type Session = {
  status: Status
  user: CurrentUser | null
  /** 启动时那次 `/me` 失败的原因。`null` 表示「确实没登录」，非空表示「没问上」 */
  bootstrapError: string | null
  /**
   * 会话为什么结束（被管理员下线 / 被另一台手机挤掉 / 空闲 / 到期 …，#138）。
   * 登录屏据此说一句为什么要重新登录；自己登出、或者压根没登录过时是 null
   */
  endReason: SessionEndReason | null
  login: (input: { username: string; password: string; uuid?: string; captcha?: string }) => Promise<void>
  logout: () => Promise<void>
  reload: () => Promise<void>
}

const SessionContext = React.createContext<Session | null>(null)

export function useSession(): Session {
  const ctx = React.useContext(SessionContext)
  if (!ctx) throw new Error('useSession 必须在 <SessionProvider> 里用')
  return ctx
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<Status>('loading')
  const [user, setUser] = React.useState<CurrentUser | null>(null)
  const [bootstrapError, setBootstrapError] = React.useState<string | null>(null)
  const [endReason, setEndReason] = React.useState<SessionEndReason | null>(null)

  /**
   * 🔴 **拿到 `/me` 就要把显示时区喂给 `@admin/i18n` 的 datetime 层。**
   *
   * 「显示时区」是**账号级**设置（`PUT /sys/users/me/timezone`，和 web 共用
   * 一份）。web 端在 `platform/src/auth/queries.ts` 的 meQuery 里调
   * `setDisplayTimeZone(me.timezone)`；移动端一直**没有这一步** ——
   * 设置屏能选、能存、`/me` 里也回来了，但界面上每个时间仍按**设备**时区渲染。
   * 那是一个「设置好了但什么都没变」的空转开关，界面上看不出错。
   *
   * ⚠️ 登出要归位（传 `null` = 回落到设备时区），否则换账号登进来还带着
   * 上一个账号的时区。
   */
  const applyUser = React.useCallback((me: CurrentUser) => {
    setDisplayTimeZone(me.timezone)
    setUser(me)
    setStatus('authed')
  }, [])

  const applyAnonymous = React.useCallback(() => {
    setDisplayTimeZone(null)
    setUser(null)
    setStatus('anonymous')
  }, [])

  // 401 且刷新失败时，api 层会回调这里 —— 这是**唯一**把会话判死的地方，
  // 业务代码不要自己清 token。回调带着服务端给的原因码（#138），留给登录屏说明
  React.useEffect(() => {
    setSessionExpiredHandler((end) => {
      setEndReason(isSessionEndReason(end.reason) ? end.reason : null)
      applyAnonymous()
    })
    return () => setSessionExpiredHandler(null)
  }, [applyAnonymous])

  const reload = React.useCallback(async () => {
    applyUser(await api.GET('/api/v1/sys/users/me'))
  }, [applyUser])

  /*
   * 冷启动引导。
   *
   * ⚠️ **这一段刻意不走 query 层**（`lib/query.tsx`），移动端其余取数都走。
   * 三个理由：
   *   1. 它决定**挂哪一棵路由树**（`AuthGate`），跑在任何屏渲染之前 ——
   *      query 的 `enabled` / `isPending` 是给「屏里的数据」用的状态机，
   *      套在这里要多一层「还没开始」和「不该开始」的区分
   *   2. 它必须**先按顺序 hydrate 两个 SecureStore**（地址再 token，顺序不能换），
   *      而那是命令式的
   *   3. 它要把 401 和「连不上」分开（见下），而不是统一当成一个 error
   *
   * 换句话说：query 层管「数据」，这一段管「会话存不存在」。**不要合并。**
   */
  React.useEffect(() => {
    let alive = true
    void (async () => {
      // 🔴 顺序不能换：地址要先读出来，否则第一个请求打的是编译期默认地址
      await serverStore.hydrate()
      await tokenStore.hydrate()
      // 🔴 SecureStore 里没有 token 时先**显式**静默恢复（cookie jar 跨冷启动是持久的）。
      // 原来是「无条件打 `/me`，没 token 的 401 由 api 层刷新兜住」—— #138 之后 api 层对
      // **没带 token** 的 401 不再刷新（那是「会话已经在本地结束了」，见 packages/api 分册），
      // 这条路就断了：cookie 还有效的人会被当成没登录
      if (!tokenStore.get()) {
        const outcome = await api.restoreSession()
        if (!alive) return
        if (outcome.kind !== 'ok') {
          // 「连不上」要带到登录屏上说清楚；「会话结束了」是正常的未登录，顺带说原因
          setBootstrapError(outcome.kind === 'transient' ? outcome.error.message : null)
          setEndReason(outcome.kind === 'ended' && isSessionEndReason(outcome.end.reason) ? outcome.end.reason : null)
          applyAnonymous()
          return
        }
      }
      try {
        const me = await api.GET('/api/v1/sys/users/me')
        if (!alive) return
        setBootstrapError(null)
        applyUser(me)
      } catch (err) {
        if (!alive) return
        // 🔴 401 和「连不上」必须区分开。
        // 没有 token（或 token 过期且刷新失败）→ 401 → 就是没登录，正常走登录屏。
        // 但**连不上服务器**也会走到这里 —— 如果一律当成「没登录」，用户看到的是
        // 一个登录屏，输对密码还是失败，而屏上没有任何东西说「是网络不通」。
        // 所以非 401 的失败要把原因带到登录屏上显示（根 CLAUDE.md 硬纪律 9）。
        const is401 = err instanceof ApiError && err.isUnauthorized
        setBootstrapError(is401 ? null : err instanceof Error ? err.message : String(err))
        applyAnonymous()
      }
    })()
    return () => {
      alive = false
    }
  }, [applyAnonymous, applyUser])

  const login = React.useCallback<Session['login']>(
    async (input) => {
      const result = await api.POST('/api/v1/auth/login', {
        body: {
          username: input.username,
          password: input.password,
          uuid: input.uuid ?? null,
          captcha: input.captcha ?? null,
          // 会话策略按端分（#138）：移动端默认 30 天空闲、同一账号只留 1 台手机
          client: 'mobile',
        },
      })
      await tokenStore.set(result.access_token)
      setEndReason(null)
      // 登录响应里的 user 是 `GetUserInfoDetail`，**没有 dept / roles 的名字**；
      // 个人中心要显示它们，所以再问一次 `/me` 拿摊平后的那份。
      await reload()
    },
    [reload],
  )

  const logout = React.useCallback(async () => {
    try {
      // 让服务端把这个会话真正作废（#138 之后一个会话就是一个 key，`session_store.revoke`）。
      // 失败也要继续往下清本地 —— 否则用户会卡在一个「点了登出还登着」的状态。
      await api.POST('/api/v1/auth/logout')
    } catch {
      // 忽略：本地清干净才是登出的语义底线
    }
    await tokenStore.clear()
    // 自己登出不需要「为什么」
    setEndReason(null)
    applyAnonymous()
  }, [applyAnonymous])

  const value = React.useMemo<Session>(
    () => ({ status, user, bootstrapError, endReason, login, logout, reload }),
    [status, user, bootstrapError, endReason, login, logout, reload],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
