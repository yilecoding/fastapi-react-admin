import { IconRotate2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { RadioGroup, RadioGroupItem } from '@admin/ui/components/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@admin/ui/components/select'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'

import type { Knob, KnobSet, KnobValues } from './kit'

/** 选项少的时候单选行比下拉好 —— 所有取值一眼看全，还能直接点 */
const RADIO_MAX = 5

function Field({
  id,
  knob,
  value,
  onChange,
}: {
  id: string
  knob: Knob
  value: string | number | boolean
  onChange: (v: string | number | boolean) => void
}) {
  if (knob.kind === 'bool') {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={`knob-${id}`} className="text-[13px] font-medium">
            {knob.label}
          </label>
          {knob.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{knob.hint}</p>}
        </div>
        <Switch
          id={`knob-${id}`}
          checked={value === true}
          onCheckedChange={(v) => onChange(v)}
          data-testid={`knob-${id}`}
        />
      </div>
    )
  }

  if (knob.kind === 'select') {
    const current = String(value)
    const items = Object.fromEntries(knob.options.map((o) => [o, o]))
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">{knob.label}</span>
        {knob.hint && <p className="-mt-1 text-[11px] text-muted-foreground">{knob.hint}</p>}
        {knob.options.length <= RADIO_MAX ? (
          <RadioGroup
            value={current}
            onValueChange={(v) => onChange(String(v))}
            className="gap-2"
            data-testid={`knob-${id}`}
          >
            {knob.options.map((opt) => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 font-mono text-[12px] text-muted-foreground has-data-checked:text-foreground"
              >
                <RadioGroupItem value={opt} />
                {opt}
              </label>
            ))}
          </RadioGroup>
        ) : (
          // Select 必须传 items，否则关闭态显示原始 value（组件约定）
          <Select value={current} items={items} onValueChange={(v) => onChange(String(v))}>
            <SelectTrigger size="sm" className="font-mono text-[12px]" data-testid={`knob-${id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {knob.options.map((opt) => (
                <SelectItem key={opt} value={opt} className="font-mono text-[12px]">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    )
  }

  if (knob.kind === 'int') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`knob-${id}`} className="text-[13px] font-medium">
            {knob.label}
          </label>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {knob.min}–{knob.max}
          </span>
        </div>
        <Input
          id={`knob-${id}`}
          type="number"
          className="h-8 font-mono text-[12px]"
          value={String(value)}
          min={knob.min}
          max={knob.max}
          data-testid={`knob-${id}`}
          onChange={(e) => {
            const raw = Number.parseInt(e.target.value, 10)
            // 空输入框会给出 NaN；夹回区间而不是让 demo 拿到 NaN 去渲染
            if (Number.isNaN(raw)) return onChange(knob.min)
            onChange(Math.min(knob.max, Math.max(knob.min, raw)))
          }}
        />
        {knob.hint && <p className="text-[11px] text-muted-foreground">{knob.hint}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`knob-${id}`} className="text-[13px] font-medium">
        {knob.label}
      </label>
      <Input
        id={`knob-${id}`}
        className="h-8 text-[13px]"
        value={String(value)}
        data-testid={`knob-${id}`}
        onChange={(e) => onChange(e.target.value)}
      />
      {knob.hint && <p className="text-[11px] text-muted-foreground">{knob.hint}</p>}
    </div>
  )
}

/** 右栏。旋钮改什么，舞台和代码就跟着变 */
export function KnobPanel({
  knobs,
  values,
  dirty,
  onChange,
  onReset,
  className,
}: {
  knobs: KnobSet
  values: KnobValues
  /** 有旋钮被改过 —— 决定「复位」是否可点 */
  dirty: boolean
  onChange: (key: string, value: string | number | boolean) => void
  onReset: () => void
  className?: string
}) {
  const entries = Object.entries(knobs)

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="knob-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] tracking-[0.2em] text-muted-foreground">KNOBS</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={!dirty}
          onClick={onReset}
          data-testid="knob-reset"
          title="回到默认值"
        >
          <IconRotate2 />
          复位
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">这个组件没有可调的参数。</p>
      ) : (
        <div className="flex flex-col gap-5">
          {entries.map(([key, knob]) => (
            <Field
              key={key}
              id={key}
              knob={knob}
              value={values[key] ?? knob.default}
              onChange={(v) => onChange(key, v)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
