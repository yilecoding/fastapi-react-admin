import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { IconSearch, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@admin/ui/components/input-group'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@admin/ui/components/popover'
import { cn } from '@admin/ui/lib/utils'

import { ICON_MAP, MenuIcon } from '../../shell/icon-registry'

/**
 * 图标选择器。
 *
 * 只从 `icon-registry` 已注册的图标里选 —— 不做全量 Tabler 检索。
 * 理由：菜单图标必须在注册表里有映射才能真正渲染出来，
 * 让用户从 5000 个 Tabler 图标里挑一个注册表没有的，选完也是显示默认图标，
 * 反而更困惑。需要新图标时先往注册表里加一条。
 *
 * 同时保留手工输入 —— 种子数据里存在把 icon 写成图片 URL 的情况。
 */
export function IconPicker({
  value,
  onChange,
  'data-testid': testId,
}: {
  value: string
  onChange: (v: string) => void
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState('')

  const names = React.useMemo(() => Object.keys(ICON_MAP).sort(), [])
  const shown = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? names.filter((n) => n.toLowerCase().includes(k)) : names
  }, [names, q])

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          /**
           * ⚠️ 这里**不能**用 `w-full`。
           *
           * 外层是 `flex items-center gap-2`，右边还有个 `size-8` 的清除按钮。
           * `w-full` = `width:100%`（容器全宽），加上兄弟按钮 32px + gap 8px，
           * 正好把内容顶出 40px —— 实测 `scrollWidth 391 vs clientWidth 351`。
           * 而抽屉的滚动容器是 `overflow-y-auto`，于是这 40px 变成一条**横向滚动条**，
           * 把所有字段标签都推出可视区（用户截图里「菜单类型」只剩「单类型」）。
           *
           * `min-w-0 flex-1`：占满剩余空间但**可以收缩**。
           */
          render={<Button type="button" variant="outline" className="min-w-0 flex-1 justify-start gap-2" />}
          data-testid={testId}
        >
          <MenuIcon name={value || null} />
          <span className={cn('truncate font-mono text-xs', !value && 'text-muted-foreground')}>
            {value || t('未设置图标')}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <InputGroup className="mb-2 h-8">
            <InputGroupAddon align="inline-start">
              <IconSearch className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              value={q} data-testid="icon-search" placeholder={t("搜索图标名…")}
              onChange={(e) => setQ(e.target.value)}
            />
          </InputGroup>
          <div className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto" data-testid="icon-grid">
            {shown.map((n) => (
              <button
                key={n}
                type="button"
                title={n}
                data-testid={`icon-opt-${n}`}
                onClick={() => { onChange(n); setOpen(false) }}
                className={cn(
                  'grid aspect-square place-content-center rounded-md border border-transparent hover:bg-muted',
                  value === n && 'border-primary bg-primary/10'
                )}
              >
                <MenuIcon name={n} className="size-4" />
              </button>
            ))}
            {shown.length === 0 && (
              <p className="col-span-6 py-6 text-center text-sm text-muted-foreground">
                {t('没有匹配的图标')}
              </p>
            )}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            <Trans
              t={t}
              i18nKey="只列出 <c>icon-registry.tsx</c> 里已注册的 {{n}} 个图标。需要新图标请先在注册表补一条映射。"
              values={{ n: names.length }}
              components={{ c: <code /> }}
            />
          </p>
        </PopoverContent>
      </Popover>

      {value && (
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0"
                aria-label={t("清除图标")} data-testid="icon-clear" onClick={() => onChange('')}>
          <IconX className="size-4" />
        </Button>
      )}
    </div>
  )
}
