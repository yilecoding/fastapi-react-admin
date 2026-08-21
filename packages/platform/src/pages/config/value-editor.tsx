import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconEye, IconEyeOff } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'

import { valueKind, type ConfigItem } from './api'
import { metaOf } from './registry'

/**
 * 单个配置项的控件。
 *
 * 库里 `value` 一律是字符串，控件类型来自注册表（`registry.ts`），
 * 注册表没写的按值推断。**写回去的必须还是原来那种字符串写法**：
 * `'true'/'false'` 的开关不能存成 `'1'`，组总开关反过来。
 * 存错了后端只是「整组配置不加载」，不报错不提示（见 api.ts）。
 */
export function ValueEditor({
  item,
  value,
  dirty,
  invalid,
  disabled,
  onChange,
}: {
  item: ConfigItem
  value: string
  dirty: boolean
  invalid?: boolean
  disabled?: boolean
  onChange: (v: string) => void
}) {
  const { t } = useTranslation()
  const meta = metaOf(item.key)
  const kind = meta?.widget ?? valueKind(item)
  const [reveal, setReveal] = React.useState(false)

  const ring = invalid
    ? 'ring-2 ring-destructive/50 border-destructive'
    : dirty
      ? 'ring-2 ring-amber-500/40'
      : undefined

  if (kind === 'switch' || kind === 'switch01' || kind === 'bool') {
    // 开/关分别写回哪个字面量，取决于这一条原本是怎么存的
    const useOne = kind === 'switch01' || (kind !== 'bool' && item.value !== 'true' && item.value !== 'false')
    const on = useOne ? '1' : 'true'
    const off = useOne ? '0' : 'false'
    const checked = value === on
    return (
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'w-8 text-right text-xs tabular-nums',
            checked ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'
          )}
        >
          {/* 用「已开启/已关闭」而不是「开启/关闭」——「关闭」在别处是 Close（按钮），
              英文共用一个 key 会让开关显示成 Close */}
          {checked ? t('已开启') : t('已关闭')}
        </span>
        <Switch
          checked={checked}
          disabled={disabled}
          data-testid={`v-${item.key}`}
          onCheckedChange={(c) => onChange(c ? on : off)}
          className={cn(dirty && 'ring-2 ring-amber-500/40 ring-offset-2 ring-offset-background')}
        />
      </div>
    )
  }

  if (kind === 'int') {
    return (
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={value}
          disabled={disabled}
          min={meta?.min}
          max={meta?.max}
          data-testid={`v-${item.key}`}
          onChange={(e) => onChange(e.target.value)}
          className={cn('h-9 w-28 text-right font-mono tabular-nums', ring)}
        />
        {meta?.unit && <span className="w-6 text-xs text-muted-foreground">{t(meta.unit)}</span>}
      </div>
    )
  }

  if (kind === 'secret') {
    return (
      <div className="flex items-center gap-1">
        <Input
          type={reveal ? 'text' : 'password'}
          value={value}
          disabled={disabled}
          placeholder={t("未设置")}
          autoComplete="new-password"
          data-testid={`v-${item.key}`}
          onChange={(e) => onChange(e.target.value)}
          className={cn('h-9 w-60 font-mono', ring)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={reveal ? t('隐藏') : t('显示')}
          data-testid={`reveal-${item.key}`}
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
        </Button>
      </div>
    )
  }

  return (
    <Input
      value={value}
      disabled={disabled}
      data-testid={`v-${item.key}`}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-9 w-60 font-mono', ring)}
    />
  )
}
