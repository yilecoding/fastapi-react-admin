import { IconCheck, IconChevronDown, IconPin, IconX } from '@tabler/icons-react'
import { menuKey } from '@admin/i18n'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuGroup, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { MenuIcon } from './icon-registry'
import { isRemovable, type Tab } from './tab-store'

/**
 * 已打开标签页的总览下拉。
 *
 * 标签条横向滚动之后，"我到底开了些什么" 就看不全了 ——
 * 这个下拉把全部 tab 一次列出来（带数量），点一行直接跳过去，
 * 当前页打勾，右边的 × 就地关掉。滚动与总览是配套的，缺一个都不好用。
 */
export function TabListMenu({
  tabs,
  activeKey,
  iconByPath,
  onSelect,
  onClose,
}: {
  tabs: Tab[]
  activeKey: string | null
  iconByPath: Map<string, string | null>
  onSelect: (tab: Tab) => void
  onClose: (key: string) => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost" size="sm" className="h-7 gap-0.5 px-1.5"
            aria-label={t('已打开 {{n}} 个标签页', { n: tabs.length })} data-testid="tab-list"
          />
        }
      >
        <IconChevronDown className="size-4" />
        <span className="text-xs tabular-nums">{tabs.length}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70dvh] w-56 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t('已打开 {{n}} 个标签页', { n: tabs.length })}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {tabs.map((tab) => {
          const active = tab.key === activeKey
          const pathname = tab.href.split('?')[0] ?? tab.href
          // 与 tab-item 同口径：key 用 pathname，回落到标题本身即 key
          const label = t(menuKey(pathname), { defaultValue: t(tab.title) })
          return (
            <DropdownMenuItem
              key={tab.key}
              data-testid={`tab-list-item-${tab.routeId}`}
              className={cn('group/row gap-2', active && 'bg-muted')}
              onClick={() => onSelect(tab)}
            >
              <MenuIcon name={iconByPath.get(pathname)} className="size-4 shrink-0" />
              <span className="flex-1 truncate">{label}</span>
              {tab.pinned && <IconPin className="size-3 shrink-0 opacity-60" />}
              {active && <IconCheck className="size-3.5 shrink-0" />}
              {isRemovable(tab) && (
                <button
                  type="button"
                  aria-label={t('关闭 {{name}}', { name: label })}
                  data-testid={`tab-list-close-${tab.routeId}`}
                  // 阻止冒泡，否则关闭同时还会把这个 tab 激活一次
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    onClose(tab.key)
                  }}
                  className="rounded-sm p-0.5 opacity-0 hover:bg-background group-hover/row:opacity-70"
                >
                  <IconX className="size-3" />
                </button>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
