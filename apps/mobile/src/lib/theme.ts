import { DarkTheme, DefaultTheme, type Theme } from 'expo-router/react-navigation'
import * as React from 'react'
import { useCSSVariable, useUniwind } from 'uniwind'

/**
 * react-navigation 的主题 —— **从 uniwind 的令牌现读，不维护第二份色板。**
 *
 * 🔴 这里原来是 `react-native-reusables` 脚手架带的一整套 zinc 色板
 * （`hsl(0 0% 100%)` / `hsl(0 0% 3.9%)` …）外加一层 `NAV_THEME` 派生。
 * 那套值**和 `src/styles/global.css` 里真正生效的令牌不是一回事** ——
 * 我们的页面底色是 iOS 分组灰 `#f4f2fa`（深色 `#000000`），
 * 而导航拿到的是纯白（深色 `#0a0a0a`）。
 *
 * 症状：**push / pop 动画期间闪一下白**（深色下闪一下不够黑的灰）。
 * 静态截图完全看不出来 —— 停下来之后每屏都自己画了 `bg-background`，
 * 只有转场那 ~300ms 里露出的是导航容器的底色。
 *
 * 修法不是「把 hex 抄对」（那就有了两份真相、web 改色时静默偏离），
 * 而是 `useCSSVariable` 现读 —— 它读的就是 uniwind 编译出来的那份，
 * 和 `bg-background` 同源。`(app)/_layout.tsx` 的 header 早就是这么做的。
 *
 * ⚠️ 只在 `theme` 变化或首帧解析出值时重算 —— `Theme` 对象每帧换引用会让
 * react-navigation 整棵树重渲染。
 */
/**
 * ⚠️ **不要给这个数组加 `as const`。** `useCSSVariable` 的重载签名是
 * `<const T extends Array<string>>(names: T)` —— 约束是**可变**数组，
 * 一个 `readonly` 元组喂不进去（`readonly [...] cannot be assigned to string[]`）。
 * 不加的话它推成 `string[]`，返回 `Array<string | number | undefined>`，
 * 解构照样能用。
 */
const NAMES = [
  '--color-background',
  '--color-border',
  '--color-card',
  '--color-destructive',
  '--color-primary',
  '--color-foreground',
]

/** 令牌值可能是 number（uniwind 会把 `16px` 解析成 16），颜色一律是 string */
const str = (v: string | number | undefined) => (typeof v === 'string' ? v : undefined)

export function useNavTheme(): Theme {
  const { theme } = useUniwind()
  const [background, border, card, destructive, primary, text] = useCSSVariable(NAMES)

  return React.useMemo(() => {
    // 回落到 react-navigation 自带的那一套：只在令牌还没解析出来时用得上
    // （首帧之前）。**不要在这里回落到自己写的 hex** —— 那就是第二份真相。
    const base = theme === 'dark' ? DarkTheme : DefaultTheme
    return {
      ...base,
      colors: {
        ...base.colors,
        background: str(background) ?? base.colors.background,
        border: str(border) ?? base.colors.border,
        card: str(card) ?? base.colors.card,
        // `notification` 是徽标底色，不是「通知功能」
        notification: str(destructive) ?? base.colors.notification,
        primary: str(primary) ?? base.colors.primary,
        text: str(text) ?? base.colors.text,
      },
    }
  }, [theme, background, border, card, destructive, primary, text])
}
