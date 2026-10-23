import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconDownload, IconFileExport, IconLoader2, IconRefresh, IconTrash } from '@tabler/icons-react'

import { formatDateTime, formatNumber } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { Pagination } from '@admin/ui/components/pagination'
import { Progress } from '@admin/ui/components/progress'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'

import { ConfirmDialog } from '../../shell/confirm-dialog'
import { StatusPill, type Tone } from '../_shared/status'
import {
  EXPORT_STATUS,
  downloadExport,
  myExportsQuery,
  useDeleteExport,
  type ExportJob,
} from '../_shared/data-io/api'
import { formatBytes } from '../file/api'

/** 写成函数里的字面量 `t('…')`：模块级常量再 `t(变量)` 的话 `i18n:check` 看不见这些 key */
function statusMeta(t: (k: string) => string, status: number): { label: string; tone: Tone } {
  switch (status) {
    case EXPORT_STATUS.pending:
      return { label: t('排队中'), tone: 'info' }
    case EXPORT_STATUS.running:
      return { label: t('生成中'), tone: 'info' }
    case EXPORT_STATUS.succeeded:
      return { label: t('已完成'), tone: 'success' }
    case EXPORT_STATUS.expired:
      return { label: t('已过期'), tone: 'muted' }
    default:
      return { label: t('失败'), tone: 'danger' }
  }
}

const PAGE_SIZE = 10

/**
 * 「我的导出」（#11 · v0.4）。大批量的导出在后台生成，生成完发站内消息，消息链到这里。
 *
 * - **只有自己的**：后端每个读接口都按 `created_by == 当前用户` 过滤，别人的记录连「存在」都不告诉
 * - 有在排队 / 生成中的就每 3 秒取一次（进度条在动），全都结束了就停 —— 面板藏起来时
 *   `<Activity>` 会销毁 effect，后台不会一直轮询（见 `_shared/settings-shell.tsx`）
 * - 文件留 `EXPORT_FILE_RETENTION_HOURS`（默认 72 小时）就删，记录留更久；过期的只剩记录、不能下载
 */
export function ExportsPanel() {
  const { t } = useTranslation()
  const [page, setPage] = React.useState(1)
  const [size, setSize] = React.useState(PAGE_SIZE)
  const query = useQuery(myExportsQuery({ page, size }))
  const { data, isPending, error, refetch, isFetching } = query
  const del = useDeleteExport()
  const [pendingDelete, setPendingDelete] = React.useState<ExportJob | null>(null)
  const [downloading, setDownloading] = React.useState<string | null>(null)

  async function handleDownload(job: ExportJob) {
    if (downloading) return
    setDownloading(job.id)
    try {
      await downloadExport(job)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('下载失败'))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="profile-exports">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-content-center rounded-md bg-primary/10 text-primary">
            <IconFileExport className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold">{t('导出记录')}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {t('数据多的导出在后台生成，完成后会发站内消息。文件到期后自动删除，只留记录。')}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t('刷新')}
          aria-busy={isFetching}
          data-testid="exports-refresh"
          onClick={() => void refetch()}
        >
          <IconRefresh className={isFetching ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:ps-[2.375rem]">
        {/* 失败必须是可见状态而不是缺失状态（硬纪律 9）：读不到 ≠ 没有导出过 */}
        {error ? (
          <QueryError error={error} onRetry={() => void refetch()} />
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <p className="text-sm text-muted-foreground" data-testid="exports-empty">
            {t('还没有导出过。列表页右上角的「导出」会把当前筛选的结果生成一份文件。')}
          </p>
        ) : (
          <>
            <ul className="flex flex-col" data-testid="exports-list">
              {data.items.map((job) => (
                <ExportRow
                  key={job.id}
                  job={job}
                  downloading={downloading === job.id}
                  onDownload={() => void handleDownload(job)}
                  onDelete={() => setPendingDelete(job)}
                />
              ))}
            </ul>
            {data.total_pages > 1 ? (
              <Pagination
                pageIndex={page - 1}
                pageCount={data.total_pages}
                pageSize={size}
                totalCount={data.total}
                onPageChange={(i) => setPage(i + 1)}
                onPageSizeChange={(s) => {
                  setSize(s)
                  setPage(1)
                }}
                testIdPrefix="exports"
              />
            ) : null}
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除导出记录')}
        description={
          pendingDelete ? t('确定删除「{{name}}」吗？文件会一起删掉。', { name: pendingDelete.file_name }) : ''
        }
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          try {
            await del.mutateAsync(pendingDelete.id)
            setPendingDelete(null)
          } catch (e) {
            toast.error(e instanceof Error ? e.message : t('删除失败'))
          }
        }}
      />
    </section>
  )
}

function ExportRow({
  job,
  downloading,
  onDownload,
  onDelete,
}: {
  job: ExportJob
  downloading: boolean
  onDownload: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const meta = statusMeta(t, job.status)
  const active = job.status === EXPORT_STATUS.pending || job.status === EXPORT_STATUS.running
  const done = job.status === EXPORT_STATUS.succeeded
  const percent = job.total > 0 ? Math.min(100, Math.round(((job.row_count ?? 0) / job.total) * 100)) : 0

  return (
    <li
      className="flex flex-col gap-2 border-b border-border/60 py-3 text-sm last:border-0"
      data-testid="export-row"
      data-status={job.status}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">{job.file_name}</span>
          <span className="text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{formatDateTime(job.created_time)}</span>
            {' · '}
            {t('{{n}} 行', { n: formatNumber(done ? (job.row_count ?? job.total) : job.total) })}
            {done && job.file_size !== null ? ` · ${formatBytes(job.file_size)}` : null}
            {done && job.expire_time ? (
              <>
                {' · '}
                {t('{{time}} 过期', { time: formatDateTime(job.expire_time) })}
              </>
            ) : null}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          {done ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('下载')}
              aria-busy={downloading}
              data-testid="export-download"
              onClick={onDownload}
            >
              {downloading ? <IconLoader2 className="size-4 animate-spin" /> : <IconDownload className="size-4" />}
            </Button>
          ) : null}
          {/* 排队 / 生成中的不给删：worker 正在写它的文件，删了记录之后那份文件就成了没人认领的孤儿 */}
          {!active ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('删除')}
              data-testid="export-delete"
              onClick={onDelete}
            >
              <IconTrash className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      {active ? (
        <div className="flex items-center gap-2" data-testid="export-progress">
          <Progress value={percent} className="h-1.5 flex-1" />
          <span className="w-10 text-end text-xs tabular-nums text-muted-foreground">{percent}%</span>
        </div>
      ) : null}
      {/* 失败原因要说出来（已经按发起人的语言翻好了）。只显示「失败」等于让人自己猜要不要重试 */}
      {job.status === EXPORT_STATUS.failed && job.error ? (
        <p className="text-xs text-destructive" data-testid="export-error">
          {job.error}
        </p>
      ) : null}
    </li>
  )
}
