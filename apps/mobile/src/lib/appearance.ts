import * as React from 'react'
import * as SecureStore from 'expo-secure-store'
import { Uniwind } from 'uniwind'

/**
 * 外观（深浅色）。三态：跟随系统 / 浅色 / 深色。
 *
 * ⚠️ **uniwind 自己不持久化主题。** `Uniwind.setTheme()` 只改当前会话，
 * 重启就回到跟随系统 —— 所以偏好要自己存，冷启动再喂回去。
 *
 * 「跟随系统」不是存一个具体值，而是存 `null`：存了 `'light'` 之后系统切深色
 * 它就不跟了，那和「跟随」是两回事。
 */
export type Appearance = 'system' | 'light' | 'dark'

const KEY = 'admin.appearance'

let cached: Appearance = 'system'
const listeners = new Set<() => void>()

function apply(v: Appearance) {
  // 🔴 uniwind 的 `setTheme` 签名是 `ThemeName | 'system'` ——
  // **'system' 是它自己认的字面量**，不是 `undefined`。
  // 之前写的是 `setTheme(undefined as never)`，命中
  //     `if (!this._themes.includes(theme)) throw`
  // 于是整个 `apply()` 抛异常：`listeners.forEach` 不跑（对勾不动）、
  // `SecureStore.delete` 不跑（旧的显式选择永远留着），而调用处是 `void` 的
  // → 一个未处理的 rejection，界面上就是「点了没反应」。
  // 那个 `as never` 断言正是把它糊过 tsc 的东西 —— 以后要写 `as never`，
  // 先想清楚是不是在骗类型检查。
  Uniwind.setTheme(v)
}

export const appearanceStore = {
  async hydrate(): Promise<void> {
    try {
      const v = (await SecureStore.getItemAsync(KEY)) as Appearance | null
      cached = v === 'light' || v === 'dark' ? v : 'system'
    } catch {
      cached = 'system'
    }
    apply(cached)
    listeners.forEach((f) => f())
  },
  current(): Appearance {
    return cached
  },
  async set(v: Appearance): Promise<void> {
    cached = v
    apply(v)
    listeners.forEach((f) => f())
    try {
      if (v === 'system') await SecureStore.deleteItemAsync(KEY)
      else await SecureStore.setItemAsync(KEY, v)
    } catch {
      // 存不下只影响下次冷启动
    }
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

export function useAppearance() {
  return React.useSyncExternalStore(appearanceStore.subscribe, appearanceStore.current)
}

/**
 * 标签的 **key**（本仓库「中文原文即 key」）。
 *
 * 🔴 **不要在这里 `t()`。** 这是模块级常量，import 那一刻就求值了 ——
 * 切语言之后它不会变，而且求值时 i18n 可能还没初始化完。
 * 一律在使用处 `t(APPEARANCE_LABEL[v])`。
 */
export const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}
