import { useTranslation } from 'react-i18next'
import {
  IconChevronLeft, IconChevronRight, IconDotsVertical, IconPencil, IconPlus, IconRefresh, IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ResetButton, StatusFilter, TextFilter } from '../_shared/filters'
import type { DataScope } from './api'

/** 左栏数据范围列表 —— 和角色管理的左栏同构：是选择器，不是表格 */
export function ScopeList({
  scopes, total, page, size, loading, busy, selectedId, keyword, status,
  onKeyword, onStatus, onReset, onPage, onSelect, onAdd, onEdit, onDelete, onRefresh,
}: {
  scopes: DataScope[]
  total: number
  page: number
  size: number
  loading: boolean
  busy: boolean
  selectedId: string | null
  keyword: string
  status: number | undefined
  onKeyword: (v: string) => void
  onStatus: (v: number | undefined) => void
  onReset: () => void
  onPage: (p: number) => void
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (s: DataScope) => void
  onDelete: (s: DataScope) => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const totalPages = Math.max(1, Math.ceil(total / size))
  const hasFilter = Boolean(keyword || status !== undefined)

  return (
    <div className="flex w-72 shrink-0 flex-col gap-3" data-testid="scope-list">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">{t('数据范围')}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label={t("刷新")} onClick={onRefresh}
                  data-testid="scope-refresh">
            <IconRefresh className={cn('size-4', busy && 'animate-spin')} />
          </Button>
          <Can perm="data:scope:add">
            <Button variant="ghost" size="icon" className="size-7" aria-label={t("新增数据范围")} onClick={onAdd}
                    data-testid="add-scope">
              <IconPlus className="size-4" />
            </Button>
          </Can>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <TextFilter
          value={keyword}
          placeholder={t("搜索范围名称…")}
          testId="filter-name"
          width="w-full"
          onCommit={onKeyword}
        />
        <div className="flex items-center gap-2">
          <StatusFilter value={status} onChange={onStatus} />
          {hasFilter && <ResetButton onClick={onReset} />}
        </div>
      </div>

      <div className="flex max-h-[calc(100svh-20rem)] flex-col gap-1 overflow-y-auto" data-testid="scope-items">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)
        ) : scopes.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">{t('没有匹配的数据范围')}</p>
        ) : (
          scopes.map((s) => (
            <div
              key={s.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                s.id === selectedId ? 'bg-accent' : 'hover:bg-muted/60'
              )}
              data-testid={`scope-item-${s.id}`}
              data-active={s.id === selectedId}
            >
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-start"
              >
                <span
                  className={cn('size-1.5 shrink-0 rounded-full', s.status === 1 ? 'bg-emerald-500' : 'bg-destructive')}
                  aria-label={s.status === 1 ? t('正常') : t('停用')}
                />
                <span className={cn('min-w-0 flex-1 truncate text-sm', s.id === selectedId && 'font-medium')}>
                  {s.name}
                </span>
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost" size="icon"
                      className={cn('size-6 shrink-0 opacity-0 group-hover:opacity-100',
                        s.id === selectedId && 'opacity-100')}
                      aria-label={t('操作 {{name}}', { name: s.name })}
                    />
                  }
                  data-testid={`scope-actions-${s.id}`}
                >
                  <IconDotsVertical className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-32">
                  <Can perm="data:scope:edit">
                    <DropdownMenuItem onClick={() => onEdit(s)} data-testid={`scope-edit-${s.id}`}>
                      <IconPencil className="size-4" />{t('编辑')}
                    </DropdownMenuItem>
                  </Can>
                  <Can perm="data:scope:del">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(s)}
                                      data-testid={`scope-delete-${s.id}`}>
                      <IconTrash className="size-4" />{t('删除')}
                    </DropdownMenuItem>
                  </Can>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
        <span data-testid="scope-total">{t('共 {{n}} 条', { n: total })}</span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" aria-label={t("上一页")}
                  disabled={page <= 1} onClick={() => onPage(page - 1)} data-testid="scope-prev">
            <IconChevronLeft className="size-3.5" />
          </Button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="size-6" aria-label={t("下一页")}
                  disabled={page >= totalPages} onClick={() => onPage(page + 1)} data-testid="scope-next">
            <IconChevronRight className="size-3.5" />
          </Button>
        </span>
      </div>
    </div>
  )
}
