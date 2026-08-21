import type { QueryClient } from '@tanstack/react-query'

import { api } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'
import { authKeys } from './queries'

export type LoginParam = {
  username: string
  password: string
  uuid?: string
  captcha?: string
}

type LoginResult = {
  access_token: string
  access_token_expire_time: string
  session_uuid: string
  password_expire_days_remaining: number | null
  user: unknown
}

export async function login(qc: QueryClient, param: LoginParam) {
  const res = await api.POST<LoginResult>('/api/v1/auth/login', { body: param })
  tokenStore.set(res.access_token)
  // 「在线用户」页要靠它认出当前会话那一行，免得管理员把自己踢下线
  tokenStore.setSessionUuid(res.session_uuid)
  // 换了身份，整份服务端状态都要重取 —— 不能只失效 me
  qc.removeQueries({ queryKey: authKeys.all })
  return res
}

export async function logout(qc: QueryClient) {
  try {
    await api.POST('/api/v1/auth/logout')
  } finally {
    tokenStore.clear()
    // 清全部缓存，避免下一个登录的人看到上一个人的数据
    qc.clear()
  }
}

export function isAuthenticated() {
  return tokenStore.get() !== null
}
