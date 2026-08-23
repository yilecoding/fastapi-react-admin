import * as React from "react"

import {
  DENSITY_PRESETS,
  RADIUS_PRESETS,
  THEME_COLORS,
  usePreferences,
  type Preferences,
  type DensityPreset,
  type RadiusPreset,
  type ScrollMode,
  type ThemeColor,
  type ThemeMode,
} from "./preferences"

/**
 * 把偏好写到 `document.documentElement` 上。
 *
 * 为什么改 CSS 变量而不是换 class：`globals.css` 里 `--primary` / `--radius`
 * 已经是**所有** `bg-primary` / `rounded-*` 的来源（`@theme inline` 引用它们），
 * 所以只要覆盖根节点上的这几个变量，全站一次生效，组件不用改一行。
 *
 * 挂载点在**应用根**（`apps/web/src/app.tsx`）而不是 `PlatformProvider` ——
 * 后者只包住登录后的外壳，登录页在它外面，会出现「登录页不跟随主题」。
 * 挂在根上，登录页和外壳共用同一套偏好；切页签也不会重置（根不重挂）。
 *
 * 首帧不能闪：React 挂载前 `main.tsx` 会先调一次 `applyPreferencesNow()`，
 * 用的是同一批函数，不会和这里的 effect 打架。
 */

/** 深浅色。`system` 时按当前系统偏好判定 */
export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
}

export function applyThemeColor(color: ThemeColor): void {
  const c = THEME_COLORS[color]
  if (!c) return
  const root = document.documentElement
  root.style.setProperty("--primary", c.primary)
  root.style.setProperty("--primary-foreground", c.foreground)
  // 侧边栏的主色单独一套变量，不同步的话选中项会跟主色对不上
  root.style.setProperty("--sidebar-primary", c.primary)
  root.style.setProperty("--sidebar-primary-foreground", c.foreground)
}

export function applyRadius(radius: RadiusPreset): void {
  const r = RADIUS_PRESETS[radius]
  if (!r) return
  document.documentElement.style.setProperty("--radius", r.value)
}

export function applyDensity(density: DensityPreset): void {
  const preset = DENSITY_PRESETS[density]
  if (!preset) return
  const root = document.documentElement
  root.dataset.density = density
  root.style.setProperty("--density-row-height", `${preset.value}px`)
}

/**
 * 滚动方式 —— 只落一个 `data-scroll-mode` 到根节点，布局分叉全在 CSS 里。
 *
 * 为什么用属性而不是 class：`globals.css` 里 `.dark` 已经占了 class 这条路，
 * 而 `@custom-variant content-scroll ([data-scroll-mode="content"] &)` 让任何一层
 * 都能写 `content-scroll:overflow-y-auto` 按祖先状态分叉 —— 不用把偏好透传下去，
 * `packages/ui` 也就不必知道 `platform` 的存在。
 */
export function applyScrollMode(mode: ScrollMode): void {
  document.documentElement.dataset.scrollMode = mode
}

/** 一次性全量应用。给「React 挂载前先上色」用，避免首帧闪白 */
export function applyPreferencesNow(p: Preferences): void {
  applyThemeMode(p.themeMode)
  applyThemeColor(p.themeColor)
  applyRadius(p.radius)
  applyDensity(p.density)
  applyScrollMode(p.scrollMode)
}
export function useApplyPreferences() {
  const themeMode = usePreferences((s) => s.themeMode)
  const themeColor = usePreferences((s) => s.themeColor)
  const radius = usePreferences((s) => s.radius)
  const density = usePreferences((s) => s.density)
  const scrollMode = usePreferences((s) => s.scrollMode)

  // 深浅色：`system` 要跟着系统偏好实时变，所以留一个 media query 监听
  React.useEffect(() => {
    applyThemeMode(themeMode)
    if (themeMode !== "system") return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyThemeMode("system")
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [themeMode])

  React.useEffect(() => applyThemeColor(themeColor), [themeColor])

  React.useEffect(() => applyRadius(radius), [radius])

  React.useEffect(() => applyDensity(density), [density])

  React.useEffect(() => applyScrollMode(scrollMode), [scrollMode])
}
