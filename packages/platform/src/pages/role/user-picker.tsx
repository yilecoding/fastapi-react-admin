import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconChevronLeft, IconChevronRight, IconLoader2, IconSearch } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@admin/ui/components/input-group'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import { candidateUsersQuery, useAddRoleUsers, type Role } from './api'

const SIZE = 8

/**
 * 「添加用户到角色」选人弹窗。
 *
 * 已经在本角色里的用户照样列出来，但置灰并标注 —— 直接过滤掉的话，
 * 搜一个名字搜不到会让人以为用户不存在，反而更费解。
 */
export function UserPicker({
  open, onOpenChange, role,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  role: Role
}) {
  const { t } = useTranslation()
  const [keyword, setKeyword] = React.useState('')
  const [committed, setCommitted] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [error, setError] = React.useState<string | null>(null)

  const add = useAddRoleUsers()

  React.useEffect(() => {
    if (!open) return
    setKeyword('')
    setCommitted('')
    setPage(1)
    setPicked(new Set())
    setError(null)
  }, [open])

  const { data, isPending, isFetching } = useQuery({
    ...candidateUsersQuery({ keyword: committed || undefined, page, size: SIZE }),
    enabled: open,
  })

  const users = data?.items ?? []
  const totalPages = Math.max(1, data?.total_pages ?? 1)

  const commit = (v: string) => { setCommitted(v); setPage(1) }

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  async function handleAdd() {
    if (picked.size === 0) return
    setError(null)
    try {
      await add.mutateAsync({ id: role.id, users: [...picked] })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('添加失败，请稍后重试'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="user-picker">
        <DialogHeader>
          <DialogTitle>{t('添加用户到「{{name}}」', { name: role.name })}</DialogTitle>
          <DialogDescription>
            {t('只会给选中的用户追加这一个角色，他们已有的其它角色不变。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-4">
          <InputGroup className="h-8">
            <InputGroupAddon align="inline-start">
              <IconSearch className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              value={keyword}
              data-testid="picker-search"
              placeholder={t("搜索用户名…回车确认")}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit(keyword)}
              onBlur={() => keyword !== committed && commit(keyword)}
            />
          </InputGroup>

          <div className={cn('min-h-64 rounded-md border p-1', isFetching && !isPending && 'opacity-60')}
               data-testid="picker-list">
            {isPending ? (
              <div className="flex flex-col gap-1 p-1">
                {Array.from({ length: SIZE }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
              </div>
            ) : users.length === 0 ? (
              <p className="py-20 text-center text-sm text-muted-foreground">{t('没有匹配的用户')}</p>
            ) : (
              users.map((u) => {
                const already = u.roles?.some((r) => r.id === role.id) ?? false
                return (
                  <div
                    key={u.id}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5',
                      already ? 'opacity-60' : 'hover:bg-muted/60'
                    )}
                    data-testid={`picker-row-${u.username}`}
                  >
                    <Checkbox
                      checked={already || picked.has(u.id)}
                      disabled={already}
                      onCheckedChange={() => toggle(u.id)}
                      data-testid={`picker-check-${u.username}`}
                      aria-label={u.username}
                    />
                    <span
                      className={cn('flex min-w-0 flex-1 items-baseline gap-2', !already && 'cursor-pointer')}
                      onClick={() => !already && toggle(u.id)}
                    >
                      <span className="truncate text-sm font-medium">{u.username}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {u.nickname}{u.dept?.name ? ` · ${u.dept.name}` : ''}
                      </span>
                    </span>
                    {already && <span className="shrink-0 text-xs text-muted-foreground">{t('已在此角色')}</span>}
                  </div>
                )
              })
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span data-testid="picker-count">{t('已选 {{n}} 人 · 共 {{total}} 个用户', { n: picked.size, total: data?.total ?? 0 })}</span>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="size-6" aria-label={t("上一页")}
                      disabled={page <= 1} onClick={() => setPage(page - 1)} data-testid="picker-prev">
                <IconChevronLeft className="size-3.5" />
              </Button>
              <span className="tabular-nums">{page} / {totalPages}</span>
              <Button variant="ghost" size="icon" className="size-6" aria-label={t("下一页")}
                      disabled={page >= totalPages} onClick={() => setPage(page + 1)} data-testid="picker-next">
                <IconChevronRight className="size-3.5" />
              </Button>
            </span>
          </div>

          {error && <p className="text-sm text-destructive" data-testid="picker-error">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
          <Button onClick={handleAdd} disabled={picked.size === 0 || add.isPending} data-testid="picker-submit">
            {add.isPending && <IconLoader2 className="size-4 animate-spin" />}
            {picked.size > 0 ? t('添加 {{n}} 人', { n: picked.size }) : t('添加')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
