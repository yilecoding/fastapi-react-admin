import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"

/**
 * 外壳偏好设置。
 *
 * 与 `tab-store` 的区别：
 *   tab-store  = 会话状态（开了哪些 tab）→ sessionStorage，新窗口应当是干净的
 *   这里       = 用户偏好（长什么样）    → localStorage，跨会话保留
 *
 * 为「偏好设置」页预留：这里是**唯一**的读写入口，
 * 设置页只需要 `usePreferences()` + `patch({...})`，不要另起一套状态。
 * 后端将来要落库（`sys_frontend_config` 字典类型已经在），
 * 也只需在这一层加一次同步，UI 侧不用动。
 */

// ─── 主题 ────────────────────────────────────────────────────────────────────

export type ThemeMode = "light" | "dark" | "system"

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "系统",
}

/**
 * 主题色预设。
 *
 * 只覆盖 `--primary` / `--primary-foreground` / `--sidebar-primary` 三个变量 ——
 * 其余色板（muted / destructive / chart-*）保持不动，换色不会牵动整套语义色。
 * 亮度都落在 0.49~0.56 之间，配近白前景在浅色与深色下都够对比度。
 */
export type ThemeColor =
  "indigo" | "blue" | "teal" | "emerald" | "amber" | "rose" | "violet"

export const THEME_COLORS: Record<
  ThemeColor,
  { label: string; primary: string; foreground: string }
> = {
  indigo: {
    label: "靛蓝",
    primary: "oklch(0.457 0.24 277.023)",
    foreground: "oklch(0.962 0.018 272.314)",
  },
  blue: {
    label: "蓝色",
    primary: "oklch(0.546 0.215 262.881)",
    foreground: "oklch(0.985 0 0)",
  },
  teal: {
    label: "青色",
    primary: "oklch(0.511 0.096 186.391)",
    foreground: "oklch(0.985 0 0)",
  },
  emerald: {
    label: "绿色",
    primary: "oklch(0.508 0.118 165.612)",
    foreground: "oklch(0.985 0 0)",
  },
  amber: {
    label: "琥珀",
    primary: "oklch(0.555 0.163 48.998)",
    foreground: "oklch(0.985 0 0)",
  },
  rose: {
    label: "玫红",
    primary: "oklch(0.551 0.222 17.585)",
    foreground: "oklch(0.985 0 0)",
  },
  violet: {
    label: "紫色",
    primary: "oklch(0.491 0.27 292.581)",
    foreground: "oklch(0.985 0 0)",
  },
}

/** 圆角。`--radius` 是所有 radius-* 的基准，改它一处全站生效 */
export type RadiusPreset =
  "sharp" | "restrained" | "balanced" | "soft" | "modern" | "round"

export const RADIUS_PRESETS: Record<
  RadiusPreset,
  { label: string; value: string }
> = {
  sharp: { label: "利落", value: "0rem" },
  restrained: { label: "克制", value: "0.35rem" },
  balanced: { label: "平衡", value: "0.5rem" },
  soft: { label: "柔和", value: "0.625rem" },
  modern: { label: "现代", value: "0.875rem" },
  round: { label: "圆润", value: "1.25rem" },
}

/**
 * 全局界面密度。`value` 是控件/行的目标基准高度，`fontSize` 是对应的正文目标值：
 * 24/12、26/13、28/14、32/16、36/18。密度是唯一入口，字号随之变化。
 */
export type DensityPreset =
  "ultraCompact" | "compact" | "standard" | "comfortable" | "spacious"

export const DENSITY_PRESETS: Record<
  DensityPreset,
  { label: string; value: number; fontSize: { value: number } }
> = {
  ultraCompact: {
    label: "极紧凑",
    value: 24,
    fontSize: { value: 12 },
  },
  compact: { label: "紧凑", value: 26, fontSize: { value: 13 } },
  standard: { label: "标准", value: 28, fontSize: { value: 14 } },
  comfortable: { label: "舒展", value: 32, fontSize: { value: 16 } },
  spacious: { label: "宽松", value: 36, fontSize: { value: 18 } },
}

/**
 * 滚动方式 —— 内容区域滚动 vs 整页滚动。
 *
 * `content`：外壳锁在视口内（`h-svh` + `overflow-hidden`），只有 `<main>` 这一层滚动。
 *            顶栏与标签条永远在原地，滚动条落在内容区右边缘。中后台的通行做法。
 * `page`：   外壳只给 `min-h-svh`，内容多了整份文档跟着滚 —— 顶栏和标签条会滚出视口。
 *            留着它是因为确实有人习惯这种（内容区不再嵌一层滚动条，长表格一路滚到底）。
 *
 * 实现只有一个开关：`document.documentElement` 上的 `data-scroll-mode`，
 * 配 `globals.css` 里的 `content-scroll:` / `page-scroll:` 两个自定义变体。
 * 需要按模式分叉的地方（目前只有 `_auth.tsx` 的外壳三层）就写这两个前缀，
 * **不要**在组件里读偏好再走 JS 分支 —— 那会让 `ui` 依赖 `platform`。
 *
 * （原来还有一处：`settings-layout` 的右栏得按模式算高度。个人中心改成切换式面板
 *  后那个自造滚动容器整根拿掉了，这条耦合随之消失。）
 */
export type ScrollMode = "content" | "page"

export const SCROLL_MODE_LABELS: Record<ScrollMode, string> = {
  content: "内容区域",
  page: "整页",
}

/** 多标签页外观。对齐参考实现的四种：按钮 / 卡片 / 柔和 / 下划线 */
export type TabStyle = "button" | "card" | "soft" | "underline"

export const TAB_STYLE_LABELS: Record<TabStyle, string> = {
  button: "按钮",
  card: "卡片",
  soft: "柔和",
  underline: "下划线",
}

export type Preferences = {
  /** 主题模式；`system` 跟随操作系统 */
  themeMode: ThemeMode
  /** 主题色预设 */
  themeColor: ThemeColor
  /** 圆角预设 */
  radius: RadiusPreset
  /** 全局界面密度 */
  density: DensityPreset
  /** 滚动方式：只滚内容区 / 整页跟着滚 */
  scrollMode: ScrollMode
  /** 顶部是否显示多标签页 */
  showTabs: boolean
  /** 多标签页外观 */
  tabStyle: TabStyle
  /** 中键关闭标签页 */
  tabMiddleClickClose: boolean
  /** 标签页上是否显示菜单图标 */
  tabShowIcon: boolean
  /** 拖拽调整标签页顺序（固定与非固定分区互不跨越） */
  tabDraggable: boolean
}

export const PREF_DEFAULTS: Preferences = {
  themeMode: "light",
  // 与 globals.css 里 :root 的默认值一致 —— 不改任何变量时视觉零变化
  themeColor: "indigo",
  radius: "soft",
  density: "standard",
  // 默认只滚内容区：顶栏与标签条不该被滚走 —— 多页签外壳里那是导航，不是内容
  scrollMode: "content",
  showTabs: true,
  tabStyle: "card",
  tabMiddleClickClose: true,
  tabShowIcon: true,
  tabDraggable: true,
}

type PrefState = Preferences & {
  /** 局部更新 —— 设置页改一项就调一次，不用关心其余字段 */
  patch: (next: Partial<Preferences>) => void
  reset: () => void
}

export const usePreferences = create<PrefState>()(
  persist(
    (set) => ({
      ...PREF_DEFAULTS,
      patch: (next) => set(next),
      reset: () => set(PREF_DEFAULTS),
    }),
    {
      name: "admin:prefs",
      storage: createJSONStorage(() => localStorage),
      // 新增字段时老用户的本地记录里没有它 —— 用默认值补齐，别让 undefined 漏进 UI。
      // `fontSize` 是旧版独立偏好，密度合并后已统一负责字号，读取时顺便丢弃旧字段。
      merge: (persisted, current) => {
        const { fontSize: _legacyFontSize, ...rest } = persisted as Partial<PrefState> & {
          fontSize?: unknown
        }
        return { ...current, ...rest }
      },
    }
  )
)
