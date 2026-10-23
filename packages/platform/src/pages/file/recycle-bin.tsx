import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconArrowBackUp, IconTrash, IconTrashX, IconX } from '@tabler/icons-react'

import { formatDateTime, toEpochMs } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { DataTablePagination } from '@admin/ui/components/data-table'
import { QueryError } from '@admin/ui/components/query-error'
import { Separator } from '@admin/ui/components/separator'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { RefreshButton, ResetButton, TextFilter } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import {
  fileStatisticsQuery,
  formatBytes,
  recycleQuery,
  useEmptyRecycle,
  usePurgeFiles,
  useRestoreFiles,
  type RecycledFile,
} from './api'
import { fileIconOf, TYPE_TONE } from './file-icon'

const DAY_MS = 24 * 3600 * 1000

/**
 * 回收站视图（文件页左栏「回收站」点进来）。
 *
 * - 回收站里的文件**一律读不到**（后端 404），所以这里没有预览 / 下载 —— 要看先还原
 * - 「还原」连带把删它那一次解开的附件关联挂回去；之前手动从附件面板移除的不会回来
 * - 「彻底删除」/「清空」删对象、不可恢复，都要二次确认
 * - 手写的行，不是 DataTable：理由同文件列表（文件名吃掉剩余宽度，其余属性靠右）
 */
export function RecycleBin({
  page,
  size,
  name,
  onSearchChange,
}: {
  page: number
  size: number
  name: string | undefined
  onSearchChange: (next: { page?: number; size?: number; name?: string }) => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [pending, setPending] = React.useState<{ kind: 'purge' | 'empty'; ids: string[] } | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const listQuery = useQuery(recycleQuery({ page, size, name }))
  const { data, isPending, isFetching } = listQuery
  const list = listState(listQuery, { onBeforeRefetch: () => setSelected(new Set()) })
  const stats = useQuery(fileStatisticsQuery()).data
  const restore = useRestoreFiles()
  const purge = usePurgeFiles()
  const empty = useEmptyRecycle()

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const days = stats?.recycle_days ?? 0
  const selectedIds = [...selected]

  const patch = (next: { page?: number; size?: number; name?: string }) => {
    // 换页 / 换筛选清掉选中：选中项可能已经不在可见行里，批量操作会打到看不见的记录上
    setSelected(new Set())
    onSearchChange({ page, size, name, ...next })
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function doRestore(ids: string[]) {
    setActionError(null)
    try {
      await restore.mutateAsync(ids)
      setSelected(new Set())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('还原失败'))
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 content-scroll:min-h-0" data-testid="recycle-bin">
      <div className="flex flex-wrap items-center gap-2">
        <TextFilter
          value={name ?? ''}
          placeholder={t('搜索文件名…')}
          testId="recycle-filter-name"
          width="w-56"
          onCommit={(v) => patch({ name: v || undefined, page: undefined })}
        />
        {name ? <ResetButton onClick={() => patch({ name: undefined, page: undefined })} /> : null}

        <div className="ms-auto flex items-center gap-2">
          {selectedIds.length > 0 && (
            <>
              <span className="text-sm tabular-nums text-muted-foreground">
                {t('已选 {{n}} 项', { n: selectedIds.length })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                <IconX className="size-4" />
                {t('取消选择')}
              </Button>
              <Can perm="sys:file:del">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restore.isPending}
                  onClick={() => void doRestore(selectedIds)}
                  data-testid="recycle-bulk-restore"
                >
                  <IconArrowBackUp className="size-4" />
                  {t('还原')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setPending({ kind: 'purge', ids: selectedIds })}
                  data-testid="recycle-bulk-purge"
                >
                  <IconTrashX className="size-4" />
                  {t('彻底删除')}
                </Button>
              </Can>
              <Separator orientation="vertical" className="h-6" />
            </>
          )}
          <RefreshButton busy={isFetching && !isPending} onClick={list.onRetry} />
          <Can perm="sys:file:del">
            <Button
              size="sm"
              variant="outline"
              disabled={total === 0}
              onClick={() => setPending({ kind: 'empty', ids: [] })}
              data-testid="recycle-empty"
            >
              <IconTrash className="size-4" />
              {t('清空回收站')}
            </Button>
          </Can>
        </div>
      </div>

      <Alert tone="info" className="py-2 text-xs" data-testid="recycle-hint">
        {days > 0
          ? t('删除的文件会在这里保留 {{days}} 天，到期自动彻底删除。还原会把文件连同删除时解开的附件关联一起放回去。', {
              days,
            })
          : t('回收站未启用（FILE_RECYCLE_DAYS = 0），删除即彻底删除。')}
      </Alert>

      {actionError && (
        <Alert tone="danger" data-testid="recycle-error">
          {actionError}
        </Alert>
      )}

      <div
        className={cn(
          'flex-1 content-scroll:min-h-0 content-scroll:overflow-y-auto content-scroll:overflow-x-hidden',
          isFetching && !isPending && 'opacity-60 transition-opacity'
        )}
        aria-busy={isFetching}
      >
        {isPending ? (
          <div className="flex flex-col gap-px rounded-lg border p-px">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.error ? (
          <QueryError error={list.error} onRetry={list.onRetry} testId="recycle-error" />
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16" data-testid="recycle-empty-state">
            <IconTrash className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">{name ? t('没有匹配的文件') : t('回收站是空的')}</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="recycle-list">
            {items.map((f) => (
              <RecycleRow
                key={f.id}
                file={f}
                checked={selected.has(f.id)}
                onToggle={() => toggle(f.id)}
                onRestore={() => void doRestore([f.id])}
                onPurge={() => setPending({ kind: 'purge', ids: [f.id] })}
                busy={restore.isPending}
              />
            ))}
          </ul>
        )}
      </div>

      <DataTablePagination
        pageIndex={page - 1}
        pageCount={data?.total_pages ?? 1}
        pageSize={size}
        selectedCount={selectedIds.length}
        totalCount={total}
        pageSizeOptions={[24, 48, 96]}
        onPageChange={(i) => patch({ page: i === 0 ? undefined : i + 1 })}
        onPageSizeChange={(s) => patch({ size: s, page: undefined })}
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === 'empty' ? t('清空回收站') : t('彻底删除')}
        description={
          pending?.kind === 'empty'
            ? t('回收站里的 {{n}} 个文件（共 {{size}}）会被彻底删除，存储里的文件一并删掉，不可恢复。', {
                n: stats?.recycle_count ?? total,
                size: formatBytes(stats?.recycle_size ?? 0),
              })
            : t('彻底删除选中的 {{n}} 个文件？存储里的文件一并删掉，不可恢复。', { n: pending?.ids.length ?? 0 })
        }
        confirmText={pending?.kind === 'empty' ? t('清空') : t('彻底删除')}
        destructive
        pending={purge.isPending || empty.isPending}
        onConfirm={async () => {
          if (!pending) return
          if (pending.kind === 'empty') await empty.mutateAsync()
          else await purge.mutateAsync(pending.ids)
          setSelected(new Set())
          setPending(null)
        }}
      />
    </div>
  )
}

function RecycleRow({
  file,
  checked,
  onToggle,
  onRestore,
  onPurge,
  busy,
}: {
  file: RecycledFile
  checked: boolean
  onToggle: () => void
  onRestore: () => void
  onPurge: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const Icon = fileIconOf(file)
  const purgeAt = toEpochMs(file.purge_time)
  const left = purgeAt === null ? null : Math.max(0, Math.ceil((purgeAt - Date.now()) / DAY_MS))

  return (
    <li className="flex items-center gap-3 px-3 py-2.5" data-testid={`recycle-row-${file.id}`}>
      <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={t('选择 {{name}}', { name: file.original_name })} />
      <Icon className={cn('size-5 shrink-0', TYPE_TONE[file.type])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={file.original_name}>
          {file.original_name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {t('删除于 {{at}}', { at: formatDateTime(file.deleted_time) })}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">{formatBytes(file.size)}</span>
      {left !== null && (
        <span
          className={cn('shrink-0 text-xs tabular-nums', left <= 3 ? 'text-destructive' : 'text-muted-foreground')}
          data-testid="recycle-days-left"
        >
          {left === 0 ? t('即将清除') : t('{{n}} 天后清除', { n: left })}
        </span>
      )}
      <Can perm="sys:file:del">
        <div className="flex shrink-0 items-center gap-0.5">
          <RowAction label={t('还原')} onClick={onRestore} disabled={busy} testId={`recycle-restore-${file.id}`}>
            <IconArrowBackUp className="size-4" />
          </RowAction>
          <RowAction label={t('彻底删除')} onClick={onPurge} testId={`recycle-purge-${file.id}`}>
            <IconTrashX className="size-4 text-destructive" />
          </RowAction>
        </div>
      </Can>
    </li>
  )
}

function RowAction({
  label,
  onClick,
  disabled,
  testId,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  testId?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={label}
            aria-busy={disabled || undefined}
            onClick={disabled ? undefined : onClick}
            data-testid={testId}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
