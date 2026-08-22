import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Input } from '@admin/ui/components/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import { cn } from '@admin/ui/lib/utils'

import { CRON_PRESETS, describeCron, nextRuns } from './cron-presets'

/**
 * Crontab 可视化构建器。
 *
 * 🔴 **它是辅助，不是唯一入口。** 表达式输入框始终可编辑、始终是**唯一真值**——
 * 构建器只往里写。反过来做（以构建器为真值、输入框只读）会把步进（每 5 分钟）、
 * 区间（`1-5`、`mon-fri`）、枚举（`1,15`）这些合法写法全变成不可表达的，
 * 而它们恰恰是 crontab 存在的理由。
 *
 * ⚠️ 这段注释里刻意不写步进的字面量 —— 那个序列会把块注释提前关掉，
 * 后面整段代码变成语法错误（写第一版时就这么炸的）。
 *
 * 所以这里只覆盖**四种最常用的周期**：每分钟 / 每小时 / 每天 / 每周。
 * 落在这四种之外的表达式，构建器切到「自定义」并退到一边，不去改它。
 */

type Preset = 'minute' | 'hour' | 'day' | 'week' | 'custom'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 从表达式反推预设 —— 编辑既有调度时要能把控件摆回正确的档 */
function parse(expr: string): { preset: Preset; minute: string; hour: string; dow: string } {
  const p = (expr ?? '').trim().split(/\s+/)
  const fallback = { preset: 'custom' as Preset, minute: '0', hour: '0', dow: '1' }
  if (p.length !== 5) return fallback
  const [min, hour, dom, mon, dow] = p
  if (dom !== '*' || mon !== '*') return fallback

  const plain = (v: string) => /^\d+$/.test(v)
  if (dow === '*') {
    if (min === '*' && hour === '*') return { preset: 'minute', minute: '0', hour: '0', dow: '1' }
    if (plain(min) && hour === '*') return { preset: 'hour', minute: min, hour: '0', dow: '1' }
    if (plain(min) && plain(hour)) return { preset: 'day', minute: min, hour, dow: '1' }
    return fallback
  }
  if (plain(dow) && plain(min) && plain(hour)) return { preset: 'week', minute: min, hour, dow }
  return fallback
}

function build(preset: Preset, minute: string, hour: string, dow: string): string | null {
  const m = String(Number(minute) || 0)
  const h = String(Number(hour) || 0)
  switch (preset) {
    case 'minute': return '* * * * *'
    case 'hour': return `${m} * * * *`
    case 'day': return `${m} ${h} * * *`
    case 'week': return `${m} ${h} * * ${dow}`
    default: return null
  }
}

export function CronBuilder({
  value,
  onChange,
  invalid,
  timeZone,
}: {
  value: string
  onChange: (next: string) => void
  invalid?: boolean
  /** beat 解释 crontab 的时区，来自 `/tasks/schedulers/meta`。见 cron-presets.ts */
  timeZone: string
}) {
  const { t, i18n } = useTranslation()
  const parsed = React.useMemo(() => parse(value), [value])
  const [preset, setPreset] = React.useState<Preset>(parsed.preset)
  const [minute, setMinute] = React.useState(parsed.minute)
  const [hour, setHour] = React.useState(parsed.hour)
  const [dow, setDow] = React.useState(parsed.dow)

  /**
   * ⚠️ 只在表达式**从外部**变成一个和当前控件不一致的值时才同步回控件
   * （打开编辑抽屉、或用户手改了输入框）。无条件同步会在
   * 「点控件 → onChange → value 变 → effect 又设一遍控件」之间来回打架。
   */
  React.useEffect(() => {
    const p = parse(value)
    if (build(preset, minute, hour, dow) === value) return
    setPreset(p.preset)
    setMinute(p.minute)
    setHour(p.hour)
    setDow(p.dow)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  function emit(next: Partial<{ preset: Preset; minute: string; hour: string; dow: string }>) {
    const p = next.preset ?? preset
    const m = next.minute ?? minute
    const h = next.hour ?? hour
    const d = next.dow ?? dow
    if (next.preset !== undefined) setPreset(next.preset)
    if (next.minute !== undefined) setMinute(next.minute)
    if (next.hour !== undefined) setHour(next.hour)
    if (next.dow !== undefined) setDow(next.dow)
    const expr = build(p, m, h, d)
    if (expr) onChange(expr)
  }

  const human = React.useMemo(() => describeCron(value, i18n.language), [value, i18n.language])
  /** 时区变了也要重算 —— 换服务器时区之后旧预览是错的 */
  const upcoming = React.useMemo(() => nextRuns(value, timeZone), [value, timeZone])

  const presetItems = React.useMemo(
    () => ({
      minute: t('每分钟'),
      hour: t('每小时'),
      day: t('每天'),
      week: t('每周'),
      custom: t('自定义'),
    }),
    [t]
  )

  const num = (v: string, set: (s: string) => void, max: number, testId: string) => (
    <Input
      type="number"
      min={0}
      max={max}
      value={v}
      data-testid={testId}
      onChange={(e) => set(e.target.value)}
      className="w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
    />
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={preset}
          items={presetItems}
          onValueChange={(v) => v && emit({ preset: v as Preset })}
        >
          <SelectTrigger size="sm" className="w-32" data-testid="cron-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(presetItems).map(([v, label]) => (
              <SelectItem key={v} value={v}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {preset === 'week' && (
          <Select
            value={dow}
            items={Object.fromEntries(WEEKDAYS.map((d, i) => [String(i), t(d)]))}
            onValueChange={(v) => v && emit({ dow: v })}
          >
            <SelectTrigger size="sm" className="w-24" data-testid="cron-dow">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d, i) => (
                <SelectItem key={i} value={String(i)}>{t(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(preset === 'day' || preset === 'week') && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            {num(hour, (s) => emit({ hour: s }), 23, 'cron-hour')}
            {t('时')}
          </span>
        )}
        {(preset === 'hour' || preset === 'day' || preset === 'week') && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            {num(minute, (s) => emit({ minute: s }), 59, 'cron-minute')}
            {t('分')}
          </span>
        )}
      </div>

      {/* 表达式框始终可编辑，它才是真值 —— 构建器只是往里写 */}
      <Input
        value={value}
        data-testid="cron-expr"
        onChange={(e) => onChange(e.target.value)}
        placeholder="* * * * *"
        className={cn('font-mono', invalid && 'border-destructive')}
      />

      {/* 常用预设：覆盖绝大多数场景，点一下就好，不用理解五段语法。
          ⚠️ 清单里刻意**没有**「每月最后一天」—— Unix cron 表达不了它
          （那是 Quartz 的 `L`），给个 `0 0 28-31 * *` 的近似值等于偷换承诺 */}
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.expr}
            type="button"
            data-testid={`cron-preset-${p.expr.replace(/[^a-zA-Z0-9]/g, '_')}`}
            onClick={() => onChange(p.expr)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs ring-1 transition-colors',
              value === p.expr
                ? 'bg-primary/10 text-primary ring-primary/30'
                : 'bg-muted/50 text-muted-foreground ring-border hover:bg-muted'
            )}
          >
            {t(p.label)}
          </button>
        ))}
      </div>

      {/* 🔴 这两行是这个控件真正的价值：说人话 + 说清楚接下来什么时候跑。
          配错的调度不会当场报错，只会在某个凌晨该跑没跑 —— 预览是唯一能
          在保存前发现「我以为是每天，其实写成了每分钟」的地方 */}
      {human ? (
        <p className="text-sm" data-testid="cron-human">{human}</p>
      ) : (
        <p className="text-sm text-destructive" data-testid="cron-human">
          {t('表达式无法解析，请检查')}
        </p>
      )}

      {upcoming.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-2" data-testid="cron-next-runs">
          <span className="text-xs text-muted-foreground">
            {t('接下来 5 次（服务端时区 {{tz}}）', { tz: timeZone })}
          </span>
          {upcoming.map((d, i) => (
            <span key={i} className="font-mono text-xs tabular-nums">{formatDateTime(d)}</span>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t('五段：分 时 日 月 周。支持 */5、1-5、1,15 这类写法，构建器覆盖不到的直接改这里。')}
      </p>
    </div>
  )
}
