import type { Demo } from '../kit'
import { COMPLEX_DEMOS } from './complex'
import { COMPOSITE_DEMOS } from './composite'
import { DISPLAY_DEMOS } from './display'
import { FEEDBACK_DEMOS } from './feedback'
import { FORM_DEMOS } from './form'
import { NAV_DEMOS } from './nav'
import { OVERLAY_DEMOS } from './overlay'
import { THEME_DEMOS } from './theme'

/**
 * 沙箱清单 —— `packages/ui` 的**完整目录**。
 *
 * 🔴 **每个组件都必须在这里出现一次。** 这不是「有空补一补」的文档，
 * 是自主型库的核心交付物：下家看不见「已经有什么」，就一定会重复造一个。
 * 闸门在 `pnpm arch:check` 的 `orphan-component` 规则 ——
 * `packages/ui/src/components` 下既没有生产调用方、又没有 demo 的组件会报错。
 *
 * 加一个组件 = 在对应分组的 `*_DEMOS` 数组里加一个对象，这个文件不用改，
 * 布局、搜索、URL 状态、代码框都不用碰。
 *
 * 文件是按 **tier**（见 `kit.ts` 的 `TIERS`）分的，不是按目录：
 *
 * | 文件 | 装什么 |
 * |---|---|
 * | `form` / `display` / `feedback` / `overlay` / `nav` | 基础组件，自包含 |
 * | `complex` | demo 需要一层带 state 的外壳的那批（**不等于** tier=complex，层级看各自的 `group`） |
 * | `composite` | 复杂组件里舞台特别大的三个，render 指向独立的 `*-demo.tsx` |
 * | `theme` | 设计令牌 |
 *
 * 「数据表格」的完全体实验台不在这里 —— 分组、排序、行列拖拽这些可调项太多，
 * 挤在沙箱小舞台里说不清楚，见 `pages/playground-table/`（`/sandbox/table`）。
 */
export const DEMOS: Demo[] = [
  ...FORM_DEMOS,
  ...DISPLAY_DEMOS,
  ...FEEDBACK_DEMOS,
  ...OVERLAY_DEMOS,
  ...NAV_DEMOS,
  ...COMPLEX_DEMOS,
  ...COMPOSITE_DEMOS,
  ...THEME_DEMOS,
]

export const demoById = (id: string | undefined): Demo | undefined =>
  id ? DEMOS.find((d) => d.id === id) : undefined

/** 兜底：URL 里的 c 认不出来时落到第一个 */
export const FIRST_DEMO = DEMOS[0] as Demo
