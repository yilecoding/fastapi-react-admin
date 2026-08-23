import * as React from 'react'

import { cn } from '@admin/ui/lib/utils'

import { b, lines, s, type Demo } from '../kit'

/**
 * 读 <html> 上真实生效的 token 值。
 *
 * 不硬编码色值 —— 硬编码的色卡会和 globals.css 漂移，而这一页存在的意义
 * 就是「现在到底是什么颜色」。切主题时 `.dark` 会加到 documentElement 上，
 * 所以挂个 MutationObserver 跟着重算。
 *
 * 注意这里读的是 documentElement（全局），不是页面内的 querySelector ——
 * 隐藏 tab 的 DOM 还在文档树里，页面内的全局选择器会命中别的页面。
 */
function useTokenValues(names: readonly string[]): Record<string, string> {
  const [values, setValues] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    const read = () => {
      const style = getComputedStyle(document.documentElement)
      const next: Record<string, string> = {}
      for (const name of names) next[name] = style.getPropertyValue(name).trim()
      setValues(next)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
    // names 是模块级常量数组，引用稳定
  }, [names])

  return values
}

type Swatch = { token: string; cls: string; label: string; onDark?: boolean }

const SURFACE: readonly Swatch[] = [
  { token: '--background', cls: 'bg-background', label: '页面底' },
  { token: '--card', cls: 'bg-card', label: '卡片' },
  { token: '--popover', cls: 'bg-popover', label: '浮层' },
  { token: '--muted', cls: 'bg-muted', label: '弱底（表头、禁用）' },
  { token: '--accent', cls: 'bg-accent', label: '强调底（hover）' },
  { token: '--sidebar', cls: 'bg-sidebar', label: '侧边栏' },
]

const BRAND: readonly Swatch[] = [
  { token: '--primary', cls: 'bg-primary', label: '主色（主按钮）', onDark: true },
  { token: '--secondary', cls: 'bg-secondary', label: '次级按钮' },
  { token: '--destructive', cls: 'bg-destructive', label: '危险', onDark: true },
]

const LINE: readonly Swatch[] = [
  { token: '--border', cls: 'bg-border', label: '描边' },
  { token: '--input', cls: 'bg-input', label: '输入框描边' },
  { token: '--ring', cls: 'bg-ring', label: '聚焦环' },
]

// ⚠️ 类名必须是字面量。`bg-chart-${i}` 这种拼出来的 Tailwind 扫不到，
// 结果是 class 在、CSS 规则不在 —— 色块全透明，还看不出为什么
const CHART: readonly Swatch[] = [
  { token: '--chart-1', cls: 'bg-chart-1', label: '图表 1', onDark: true },
  { token: '--chart-2', cls: 'bg-chart-2', label: '图表 2', onDark: true },
  { token: '--chart-3', cls: 'bg-chart-3', label: '图表 3', onDark: true },
  { token: '--chart-4', cls: 'bg-chart-4', label: '图表 4', onDark: true },
  { token: '--chart-5', cls: 'bg-chart-5', label: '图表 5', onDark: true },
]

const SECTIONS = [
  { title: '表面', items: SURFACE },
  { title: '品牌与语气', items: BRAND },
  { title: '线与环', items: LINE },
  { title: '图表', items: CHART },
] as const

const ALL_TOKENS = SECTIONS.flatMap((sec) => sec.items.map((i) => i.token))

// 同理，圆角档位也要写死类名
const RADII = [
  { name: 'rounded-sm', cls: 'rounded-sm' },
  { name: 'rounded-md', cls: 'rounded-md' },
  { name: 'rounded-lg', cls: 'rounded-lg' },
  { name: 'rounded-xl', cls: 'rounded-xl' },
  { name: 'rounded-2xl', cls: 'rounded-2xl' },
  { name: 'rounded-3xl', cls: 'rounded-3xl' },
] as const
const RADIUS_TOKENS = ['--radius'] as const

function ColorGrid({ showValue }: { showValue: boolean }) {
  const values = useTokenValues(ALL_TOKENS)
  return (
    <div className="flex w-full flex-col gap-6">
      {SECTIONS.map((sec) => (
        <div key={sec.title} className="flex flex-col gap-2.5">
          <span className="font-mono text-2xs tracking-[0.2em] text-muted-foreground">
            {sec.title}
          </span>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {sec.items.map((sw) => (
              <div
                key={sw.token}
                className="flex items-center gap-2.5 rounded-lg border border-border/70 p-2"
              >
                <span
                  className={cn(
                    'size-9 shrink-0 rounded-md border border-border/60',
                    sw.cls
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{sw.token}</p>
                  <p className="truncate text-xs text-muted-foreground">{sw.label}</p>
                  {showValue && (
                    <p className="truncate font-mono text-2xs text-muted-foreground/80">
                      {values[sw.token] || '—'}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function RadiusGrid({ showValue }: { showValue: boolean }) {
  const values = useTokenValues(RADIUS_TOKENS)
  return (
    <div className="flex w-full flex-col gap-3">
      {showValue && (
        <p className="font-mono text-xs text-muted-foreground">
          --radius: {values['--radius'] || '—'} —— 其余档位都是它的倍数（见 globals.css 的 @theme）
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {RADII.map((r) => (
          <div key={r.name} className="flex flex-col items-center gap-1.5">
            <span className={cn('size-14 border border-border bg-muted', r.cls)} />
            <span className="font-mono text-2xs text-muted-foreground">{r.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const TYPE_SCALE = [
  { cls: 'text-2xl font-semibold', label: 'text-2xl · 页内大标题' },
  { cls: 'text-base font-medium', label: 'text-base · 小节标题' },
  { cls: 'text-sm', label: 'text-sm · 正文（后台默认）' },
  { cls: 'text-sm', label: 'text-sm · 表单标签' },
  { cls: 'text-xs text-muted-foreground', label: 'text-xs · 辅助说明' },
  { cls: 'font-mono text-2xs tracking-[0.2em] text-muted-foreground', label: 'font-mono · 标号与版本' },
] as const

export const THEME_DEMOS: Demo[] = [
  {
    id: 'color',
    name: 'Color',
    zh: '调色盘',
    group: 'theme',
    summary:
      '读的是 <html> 上真实生效的 token 值，不是硬编码色卡 —— 切主题这一页跟着变。业务代码里只用这些 token，不要写具体色值。',
    source: 'packages/ui/src/styles/globals.css',
    stage: 'stretch',
    knobs: {
      view: { kind: 'select', label: '看什么', options: ['颜色', '圆角', '字级'], default: '颜色' },
      showValue: { kind: 'bool', label: '显示计算值', default: true },
    },
    render: (v) => {
      const view = s(v, 'view')
      if (view === '圆角') return <RadiusGrid showValue={b(v, 'showValue')} />
      if (view === '字级')
        return (
          <div className="flex w-full flex-col gap-3">
            {TYPE_SCALE.map((t) => (
              <div key={t.label} className="flex flex-col gap-0.5">
                <span className={t.cls}>一个入口，管好权限与数据 · Aa 0123</span>
                <span className="font-mono text-2xs text-muted-foreground">{t.label}</span>
              </div>
            ))}
          </div>
        )
      return <ColorGrid showValue={b(v, 'showValue')} />
    },
    code: (v) => {
      const view = s(v, 'view')
      if (view === '圆角')
        return lines(
          '/* globals.css 的 @theme inline 里，各档都是 --radius 的倍数 */',
          '--radius-sm: calc(var(--radius) * 0.6);',
          '--radius-lg: var(--radius);',
          '--radius-2xl: calc(var(--radius) * 1.8);'
        )
      if (view === '字级')
        return lines(
          '{/* 后台正文用 text-sm，表单标签 13px，辅助说明 text-xs */}',
          '<p className="text-sm">正文</p>',
          '<span className="text-xs text-muted-foreground">辅助说明</span>'
        )
      return lines(
        '{/* 只用 token，不写具体色值 —— 深浅两套主题才会一起对 */}',
        '<div className="bg-card text-card-foreground border-border">…</div>',
        '<Button className="bg-primary text-primary-foreground">主操作</Button>'
      )
    },
  },
]
