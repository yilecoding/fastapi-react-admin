import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconCheck, IconSearch, IconSelector, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@admin/ui/components/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@admin/ui/components/popover'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

export type PickUser = { id: string; nickname: string; username: string; dept_name?: string | null }

/** 数据从哪来由调用方给：审批走通讯录接口，部门负责人走 `/sys/users` —— 两边的权限不一样 */
export type UserSource = {
  key: readonly unknown[]
  search: (keyword: string | undefined) => Promise<PickUser[]>
  /** 按 ID 回查姓名。不给就只能显示调用方给的 `labels` 或 ID */
  byIds?: (ids: string[]) => Promise<PickUser[]>
}

/**
 * 选人控件（单选 / 多选，服务端搜索）。
 *
 * 值是用户 ID **字符串数组**（单选也是数组，0 或 1 个），不 `Number()`（硬纪律 6）。
 * 已选的人按 ID 回查一次姓名：值可能来自别处（草稿、实例数据），不在当前搜索结果里。
 */
export function UserSelect({
  value,
  onChange,
  multiple = false,
  disabled,
  placeholder,
  exclude,
  testId = 'user-select',
  source,
  labels,
}: {
  source: UserSource
  /** 调用方已经知道的姓名（比如部门树里带着的负责人昵称），回查之前先用它 */
  labels?: Record<string, string>
  value: string[]
  onChange: (v: string[]) => void
  multiple?: boolean
  disabled?: boolean
  placeholder?: string
  /** 不可选的人（比如转交时排除自己） */
  exclude?: string[]
  testId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [keyword, setKeyword] = React.useState('')
  const [committed, setCommitted] = React.useState('')

  const picked = useQuery({
    queryKey: [...source.key, 'ids', value],
    queryFn: () => source.byIds?.(value) ?? Promise.resolve([]),
    enabled: value.length > 0 && !!source.byIds,
    staleTime: 60_000,
  })
  const search = useQuery({
    queryKey: [...source.key, 'search', committed],
    queryFn: () => source.search(committed || undefined),
    enabled: open,
    staleTime: 60_000,
  })

  const nameOf = React.useMemo(() => {
    const m = new Map<string, PickUser>()
    for (const [id, nickname] of Object.entries(labels ?? {})) m.set(id, { id, nickname, username: '' })
    for (const u of [...(picked.data ?? []), ...(search.data ?? [])]) m.set(u.id, u)
    return m
  }, [picked.data, search.data, labels])

  const toggle = (id: string) => {
    if (multiple) onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
    else {
      onChange(value[0] === id ? [] : [id])
      setOpen(false)
    }
  }

  const label = value.length
    ? value.map((id) => nameOf.get(id)?.nickname ?? (picked.isFetching ? '…' : source.byIds ? t('（已删除的用户）') : id)).join('、')
    : ''

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-9 w-full justify-between px-3 font-normal"
            data-testid={testId}
          />
        }
      >
        <span className={cn('truncate', !label && 'text-muted-foreground')}>
          {label || placeholder || t('选择人员')}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {value.length > 0 && !disabled && (
            <span
              role="button"
              tabIndex={0}
              aria-label={t('清空')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation()
                onChange([])
              }}
            >
              <IconX className="size-3.5" />
            </span>
          )}
          <IconSelector className="size-4 text-muted-foreground" />
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start">
            <IconSearch className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={keyword}
            placeholder={t('搜索姓名或用户名，回车确认')}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setCommitted(keyword.trim())
              }
            }}
            data-testid={`${testId}-search`}
          />
        </InputGroup>
        <div className="mt-2 max-h-64 overflow-y-auto">
          {search.isPending ? (
            <div className="flex flex-col gap-1">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : search.error ? (
            <p className="py-6 text-center text-sm text-destructive">{t('加载失败，请重试')}</p>
          ) : (search.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('没有匹配的用户')}</p>
          ) : (
            (search.data ?? []).map((u) => {
              const off = exclude?.includes(u.id)
              const on = value.includes(u.id)
              return (
                <button
                  key={u.id}
                  type="button"
                  disabled={off}
                  onClick={() => toggle(u.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    off ? 'opacity-50' : 'hover:bg-muted'
                  )}
                  data-testid={`${testId}-opt-${u.username}`}
                >
                  <IconCheck className={cn('size-4 shrink-0', on ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate font-medium">{u.nickname}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {u.username}{u.dept_name ? ` · ${u.dept_name}` : ''}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
