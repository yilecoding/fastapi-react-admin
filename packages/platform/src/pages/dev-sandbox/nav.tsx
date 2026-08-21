import { IconSearch } from '@tabler/icons-react'

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@admin/ui/components/input-group'
import { cn } from '@admin/ui/lib/utils'

import { GROUPS, type Demo } from './kit'

/**
 * 左栏。按 kit.ts 的 GROUPS 分组，搜索命中组件名（中英文都算）和摘要。
 *
 * 搜索词进 URL（硬纪律 2）：翻到某个组件、把链接发给同事，对方打开看到的是同一屏。
 */
export function SandboxNav({
  demos,
  active,
  query,
  onQuery,
  onSelect,
  className,
}: {
  demos: Demo[]
  active: string
  query: string
  onQuery: (q: string) => void
  onSelect: (id: string) => void
  className?: string
}) {
  const q = query.trim().toLowerCase()
  const hit = (d: Demo) =>
    !q ||
    d.name.toLowerCase().includes(q) ||
    d.zh.includes(q) ||
    d.id.includes(q) ||
    d.summary.toLowerCase().includes(q)

  const matched = demos.filter(hit)

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="sandbox-nav">
      <InputGroup className="h-8">
        <InputGroupAddon align="inline-start">
          <IconSearch />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="搜组件"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          data-testid="sandbox-search"
        />
      </InputGroup>

      {matched.length === 0 ? (
        <p className="px-1 text-[13px] text-muted-foreground">
          没有匹配「{query}」的组件。
        </p>
      ) : (
        GROUPS.map((group) => {
          const items = matched.filter((d) => d.group === group.id)
          if (!items.length) return null
          return (
            <div key={group.id} className="flex flex-col gap-0.5">
              <span className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                {group.label}
              </span>
              {items.map((d) => {
                const on = d.id === active
                return (
                  <button
                    key={d.id}
                    type="button"
                    data-testid={`sandbox-item-${d.id}`}
                    data-active={String(on)}
                    onClick={() => onSelect(d.id)}
                    className={cn(
                      'flex items-baseline gap-2 rounded-md px-2 py-1.5 text-start transition-colors',
                      on
                        ? 'bg-muted font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60'
                    )}
                  >
                    <span className="truncate text-[13px]">{d.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground/70">{d.zh}</span>
                  </button>
                )
              })}
            </div>
          )
        })
      )}
    </div>
  )
}
