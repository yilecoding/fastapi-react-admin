import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../api-client/client'

/**
 * 服务端的个人偏好（#202）：`GET / PUT /api/v1/sys/users/me/preferences/{key}`。
 *
 * 和 `shell/preferences.ts`（localStorage）的分工：那边是「这块屏幕上我想看到什么」（主题 / 标签条外观），
 * 这边是「我这个人的设置」—— 换台电脑、从网页换到桌面端都要还在。第一期只有工作台布局。
 *
 * - 没存过时接口回 200 + `value: null`，**不是 404**：`error` 只表示真的读失败了（硬纪律 9）
 * - 只能读写自己的：路径里没有用户 ID，后端永远按登录的人取
 * - 值任意 JSON（不能是 null），序列化后不超过 16 KB；键是 `命名空间.名字` 的小写格式
 */
export type UserPreference<T = unknown> = {
  key: string
  /** `null` = 没存过 */
  value: T | null
  updated_time: string | null
}

export const userPreferenceKeys = {
  all: ['sys', 'users', 'me', 'preferences'] as const,
  one: (key: string) => [...userPreferenceKeys.all, key] as const,
}

const path = (key: string) => `/api/v1/sys/users/me/preferences/${encodeURIComponent(key)}`

export const userPreferenceQuery = (key: string) =>
  queryOptions({
    queryKey: userPreferenceKeys.one(key),
    queryFn: () => api.GET<UserPreference>(path(key)),
  })

/** 整份覆盖。成功后直接用响应写缓存（响应就是存下的那一份），不再多打一次 GET */
export function useSaveUserPreference(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (value: unknown) => api.PUT<UserPreference>(path(key), { body: { value } }),
    onSuccess: (saved) => qc.setQueryData(userPreferenceKeys.one(key), saved),
    // 失败由调用处就地画出来（工作台编辑器里的错误块），全局那条 toast 再弹一次就是同一个错误说两遍
    meta: { suppressErrorToast: true },
  })
}
