import type { Demo } from '../kit'
import { DATA_DEMOS } from './data'
import { FEEDBACK_DEMOS } from './feedback'
import { FORM_DEMOS } from './form'
import { OVERLAY_DEMOS } from './overlay'
import { THEME_DEMOS } from './theme'

/**
 * 沙箱清单。
 *
 * 加一个组件 = 在对应分组的 `*_DEMOS` 数组里加一个对象，这个文件不用改，
 * 布局、搜索、URL 状态、代码框都不用碰。
 *
 * 表格分两处：这里的 `data-grid` 条目挂常用能力（密度/固定列/展开/右键/批量条/虚拟滚动），
 * 够看清一张业务表长什么样、代码能抄走；分组、排序、行列拖拽这些可调项太多，
 * 挤在沙箱小舞台里说不清楚，放 `/sandbox/table` 那个专门的实验台。
 */
export const DEMOS: Demo[] = [
  ...FORM_DEMOS,
  ...FEEDBACK_DEMOS,
  ...OVERLAY_DEMOS,
  ...DATA_DEMOS,
  ...THEME_DEMOS,
]

export const demoById = (id: string | undefined): Demo | undefined =>
  id ? DEMOS.find((d) => d.id === id) : undefined

/** 兜底：URL 里的 c 认不出来时落到第一个 */
export const FIRST_DEMO = DEMOS[0] as Demo
