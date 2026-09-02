import * as React from 'react'

import { ApiError } from '@admin/api'

import { api, setSessionExpiredHandler } from '@/lib/api'
import type { CurrentUser, LoginResult } from '@/lib/contract'
import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

type Status = 'loading' | 'authed' | 'anonymous'

type Session = {
  status: Status
  user: CurrentUser | null
  /** 启动时那次 `/me` 失败的原因。`null` 表示「确实没登录」，非空表示「没问上」 */
  bootstrapError: string | null
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

  const applyAnonymous = React.useCallback(() => {
    setUser(null)
    setStatus('anonymous')
  }, [])

  // 401 且刷新失败时，api 层会回调这里 —— 这是**唯一**把会话判死的地方，
  // 业务代码不要自己清 token。
  React.useEffect(() => {
    setSessionExpiredHandler(applyAnonymous)
    return () => setSessionExpiredHandler(null)
  }, [applyAnonymous])

  const reload = React.useCallback(async () => {
    const me = await api.GET<CurrentUser>('/api/v1/sys/users/me')
    setUser(me)
    setStatus('authed')
  }, [])

  // 冷启动
  React.useEffect(() => {
    let alive = true
    void (async () => {
      // 🔴 顺序不能换：地址要先读出来，否则第一个请求打的是编译期默认地址
      await serverStore.hydrate()
      await tokenStore.hydrate()
      try {
        const me = await api.GET<CurrentUser>('/api/v1/sys/users/me')
        if (!alive) return
        setUser(me)
        setBootstrapError(null)
        setStatus('authed')
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
  }, [applyAnonymous])

  const login = React.useCallback<Session['login']>(
    async (input) => {
      const result = await api.POST<LoginResult>('/api/v1/auth/login', {
        username: input.username,
        password: input.password,
        uuid: input.uuid ?? null,
        captcha: input.captcha ?? null,
      })
      await tokenStore.set(result.access_token)
      // 登录响应里的 user 是 `GetUserInfoDetail`，**没有 dept / roles 的名字**；
      // 个人中心要显示它们，所以再问一次 `/me` 拿摊平后的那份。
      await reload()
    },
    [reload],
  )

  const logout = React.useCallback(async () => {
    try {
      // 让服务端把这个会话真正作废（access + refresh + 用户缓存三组 key）。
      // 失败也要继续往下清本地 —— 否则用户会卡在一个「点了登出还登着」的状态。
      await api.POST('/api/v1/auth/logout')
    } catch {
      // 忽略：本地清干净才是登出的语义底线
    }
    await tokenStore.clear()
    applyAnonymous()
  }, [applyAnonymous])

  const value = React.useMemo<Session>(
    () => ({ status, user, bootstrapError, login, logout, reload }),
    [status, user, bootstrapError, login, logout, reload],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
