import * as React from 'react'
import * as SecureStore from 'expo-secure-store'

import { API_BASE_DEFAULT } from '@/lib/config'

/**
 * 服务器地址 —— **运行时可改**，不是编译期常量。
 *
 * 🔴 打成 APK 之后 `EXPO_PUBLIC_*` 就焊死了（那是构建期替换的字符串）。
 * 一个中后台 App 至少要能在「生产 / 预发 / 本机」之间切，否则每换一个环境
 * 都要重新打一个包。所以地址存 SecureStore，登录前可改。
 *
 * ⚠️ 改地址必须**登出**：token 是跟着服务器发的，换了服务器旧 token 一定无效，
 * 而那个失败会表现成「莫名其妙 401」。所以设置屏改完直接清会话。
 *
 * 读是同步的（`current()`），因为每个请求都要拿它 —— 启动时 `hydrate()` 一次进内存。
 */
const KEY = 'admin.api_base'

let cached: string | null = null
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => fn())
}

export const serverStore = {
  /** 冷启动时调用一次 */
  async hydrate(): Promise<void> {
    try {
      cached = await SecureStore.getItemAsync(KEY)
    } catch {
      cached = null
    }
    notify()
  },

  /** 当前地址。没设过就回落到编译期默认值（dev 下由 scripts/dev.mjs 注入） */
  current(): string {
    return cached ?? API_BASE_DEFAULT
  },

  /** 有没有被手工改过 —— 设置屏要显示「已自定义」 */
  isCustom(): boolean {
    return cached !== null
  },

  async set(base: string | null): Promise<void> {
    const next = base?.trim().replace(/\/+$/, '') || null
    cached = next
    try {
      if (next) await SecureStore.setItemAsync(KEY, next)
      else await SecureStore.deleteItemAsync(KEY)
    } catch {
      // 存不下只影响下次冷启动，本次会话仍然用新地址
    }
    notify()
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

/** 组件里读地址。地址变了要重渲染（设置屏、登录页的错误提示都要跟着变） */
export function useServer() {
  const base = React.useSyncExternalStore(serverStore.subscribe, serverStore.current)
  return { base, isCustom: serverStore.isCustom() }
}
