import type * as React from 'react'

/**
 * 组件沙箱的内核：旋钮描述 + 代码生成。
 *
 * 一个 demo 只需要给三样东西 —— 旋钮有哪些、怎么渲染、代码长什么样。
 * 「加一个组件」= 一个对象 + 一行注册（见 demos/index.ts），
 * 布局、搜索、URL 状态、代码框都不用碰。
 */

export type Knob =
  | { kind: 'select'; label: string; options: readonly string[]; default: string; hint?: string }
  | { kind: 'bool'; label: string; default: boolean; hint?: string }
  | { kind: 'text'; label: string; default: string; hint?: string }
  | { kind: 'int'; label: string; default: number; min: number; max: number; hint?: string }

export type KnobSet = Record<string, Knob>
export type KnobValues = Record<string, string | number | boolean>

export function defaultsOf(knobs: KnobSet): KnobValues {
  const out: KnobValues = {}
  for (const [key, knob] of Object.entries(knobs)) out[key] = knob.default
  return out
}

/** 读旋钮值。demo 里到处 `String(v.x ?? '')` 太吵 */
export const s = (v: KnobValues, k: string): string => String(v[k] ?? '')
export const b = (v: KnobValues, k: string): boolean => v[k] === true
export const n = (v: KnobValues, k: string): number => Number(v[k] ?? 0)

/**
 * 目录的两级分类：**层级（tier）** 在上，**分组（group）** 在下。
 *
 * 🔴 分层的判据是「拿走之后要接多少东西」，不是「代码多长」：
 *
 * | tier | 判据 | 拿走它要做什么 |
 * |---|---|---|
 * | `basic` | 自包含。props 进、DOM 出 | 复制文件即可 |
 * | `complex` | 有**外部契约**：要喂数据源 / 要接状态 / 要注入能力 | 得读一遍它的契约 |
 * | `token` | 不是组件，是设计变量 | 改 `globals.css` |
 *
 * 为什么按这条线分：这个库的定位是**被下游整包拿走自己改**（见 PORTING.md）。
 * 下家第一件事是判断「哪些我可以直接用、哪些得先搞懂」——
 * 按「表单 / 反馈 / 弹层」分只回答了「它长什么样」，不回答这个问题。
 * `Button` 和 `DataGrid` 放在同一层平铺，是在骗人。
 */
export const TIERS = [
  {
    id: 'basic',
    label: '基础组件',
    hint: '自包含：props 进、DOM 出。拿走复制文件就能用。',
  },
  {
    id: 'complex',
    label: '复杂组件',
    hint: '有外部契约：要喂数据源、接状态或注入能力。拿走前先读它的契约。',
  },
  { id: 'token', label: '设计令牌', hint: '不是组件，是主题变量。改 globals.css 一处。' },
] as const

export type TierId = (typeof TIERS)[number]['id']

export const GROUPS = [
  // ── 基础组件 ──
  { id: 'form', label: '输入与表单', tier: 'basic' },
  { id: 'display', label: '数据展示', tier: 'basic' },
  { id: 'feedback', label: '反馈与状态', tier: 'basic' },
  { id: 'overlay', label: '弹层', tier: 'basic' },
  { id: 'nav', label: '导航', tier: 'basic' },
  // ── 复杂组件 ──
  { id: 'table', label: '表格', tier: 'complex' },
  { id: 'composite', label: '成套能力', tier: 'complex' },
  // ── 设计令牌 ──
  { id: 'theme', label: '主题', tier: 'token' },
] as const satisfies readonly { id: string; label: string; tier: TierId }[]

export type GroupId = (typeof GROUPS)[number]['id']

/**
 * 例行里的一个条目，两种形态：
 *
 * - `preview` 铺开对比用。复用 demo 的 `render`，只喂不同旋钮值。
 *   **只看不点** —— 示例本身往往就是按钮，再套一层可点元素是非法 HTML
 *   （button 套 button），点击行为也会互相抢。要代码走右栏旋钮。
 * - `action` 触发行为用。像 Toast 这种「组件本身不在页面上」的，
 *   能演示的只有「点一下发生什么」。
 */
export type SpecimenItem =
  | {
      kind: 'preview'
      /** 这个示例代表的旋钮取值，没给的沿用默认值 */
      values: KnobValues
      /** 示例下方的小字。示例自己已经说清楚时就不用给 */
      caption?: string
    }
  | {
      kind: 'action'
      label: string
      run: () => void
      /** 按钮下方的小字，说明这一下到底覆盖了什么 */
      caption?: string
    }

/** 一个小节：标题 + 一句说明 + 一排条目 */
export type SpecimenRow = {
  title: string
  hint: string
  items: SpecimenItem[]
}

/** 两个小工具，省掉 demo 里成片的 `kind: 'preview'` */
export const preview = (values: KnobValues, caption?: string): SpecimenItem => ({
  kind: 'preview',
  values,
  ...(caption ? { caption } : {}),
})

export const action = (label: string, run: () => void, caption?: string): SpecimenItem => ({
  kind: 'action',
  label,
  run,
  ...(caption ? { caption } : {}),
})

export type Demo = {
  /** URL 里的标识，小写连字符 */
  id: string
  /** 组件名，和 packages/ui 的导出一致 */
  name: string
  zh: string
  group: GroupId
  summary: string
  /** 组件源文件（相对仓库根）—— 抄用法时能直接找过去 */
  source: string
  /**
   * 「什么时候用它」。一句话，界面上直接显示。
   *
   * 🔴 这一栏是**目录的主要价值**，不是装饰。自主型库的失败模式是
   * 「下家没看见已经有什么，于是重新造了一个」——
   * 而人不会去读 `AGENTS.md` 里那张表，只会翻这个目录。
   */
  use: string
  /** 「什么时候别用它」+ 该用什么。没有真实误用风险的组件可以不给 */
  avoid?: string
  /** 舞台布局：center 居中放小件，stretch 占满放表格这种 */
  stage?: 'center' | 'stretch'
  knobs: KnobSet
  render: (v: KnobValues) => React.ReactNode
  code: (v: KnobValues) => string
  /**
   * 铺开对比用的例行。给了就渲染在舞台上方 ——
   * 挑变体、挑尺寸靠「一次看全」，靠旋钮一个个切太慢。
   * 每个示例复用同一个 `render`，只是喂不同的旋钮值。
   */
  rows?: SpecimenRow[]
}

type Attr = string | number | boolean | undefined | null

const WRAP_AT = 56

/**
 * 拼 JSX。
 *
 * 规则：`false` / `undefined` / 空串的 prop **不出现在代码里**。
 * 代码块的用处是「抄走就能用」，塞满 `variant="default"` `disabled={false}`
 * 这种等于默认值的噪音，人就得自己去分辨哪些是真的要写 —— 那就白给了。
 */
export function jsx(tag: string, props: Record<string, Attr>, children?: string): string {
  const attrs: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false || value === '') continue
    if (value === true) attrs.push(key)
    else if (typeof value === 'number') attrs.push(`${key}={${value}}`)
    else attrs.push(`${key}="${value}"`)
  }

  const oneLine = attrs.length ? `${tag} ${attrs.join(' ')}` : tag
  // 属性长到一行放不下就竖排，缩进对齐到标签名后面
  const multi = attrs.length > 1 && oneLine.length > WRAP_AT
  const head = multi ? `${tag} ${attrs.join(`\n${' '.repeat(tag.length + 2)}`)}` : oneLine

  if (children === undefined) return multi ? `<${head}\n/>` : `<${head} />`
  const body = children
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n')
  return `<${head}>\n${body}\n</${tag}>`
}

/** 多行拼接，过滤掉空片段 —— demo 里条件拼代码时很常用 */
export const lines = (...parts: Array<string | false | undefined | null>): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n')
