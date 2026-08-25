import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLayoutGrid, IconLayoutList, IconTrash, IconUpload, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTablePagination } from '@admin/ui/components/data-table'
import { QueryError } from '@admin/ui/components/query-error'
import { Separator } from '@admin/ui/components/separator'
import { Skeleton } from '@admin/ui/components/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@admin/ui/components/toggle-group'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { fetchBytes } from '../../api-client/client'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { ResetButton, TextFilter } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import {
  filesQuery,
  formatBytes,
  useDeleteFiles,
  useUploadFile,
  type FileItem,
  type FileListParams,
  type FileType,
  type FileView,
} from './api'
import { FileDetailSheet } from './detail-sheet'
import { FileGrid } from './file-grid'
import { FileList } from './file-list'
import { FileRail } from './file-rail'
import { FilePreviewDialog } from './preview-dialog'
import type { FileActions } from './file-menu'
import { DEFAULT_GRID_PAGE_SIZE } from '../_shared/pagination'

/**
 * 文件管理。
 *
 * **不是列表页模板** —— 参照文件管理器的形态：左栏分类 + 存储统计，
 * 右侧宫格卡片（图片出真实缩略图），可切列表。
 * 原来用 `DataTable` 做的那一版问题在于：七列等宽表头把最该看的文件名挤成一小格，
 * 「校验和」这种排障字段常驻占位，而「这是张什么图」完全看不出来。
 * 表格适合多行同构数据的对齐扫描，文件不是那种数据。
 *
 * 硬纪律：组件 router-独立（search 走 props，内部不碰 `Route.useSearch()`），
 * 分类 / 搜索 / 视图 / 分页全进 URL。
 */
export type FilePageSearch = {
  page?: number
  size?: number
  name?: string
  type?: FileType
  /** 宫格 / 列表。进 URL，刷新后保持 */
  view?: FileView
}

export function FilePage({
  search = {},
  onSearchChange,
}: {
  search?: FilePageSearch
  onSearchChange?: (next: FilePageSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  // 宫格一行最多 8 个，24 = 整 3 行，翻页时不会留下半行空档
  const size = search.size ?? DEFAULT_GRID_PAGE_SIZE
  const view: FileView = search.view ?? 'grid'

  // 选中项是**会话级**的，不进 URL：几十个雪花 ID 塞进地址栏不现实
  // （树形展开状态同理，见 `_shared/use-tree-fold`）
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const patch = React.useCallback(
    (next: Partial<FilePageSearch>) => {
      // 换页/换分类清掉选中：分页在服务端，留着的选中项已不在可见行里，
      // 批量删除会打到用户看不见的记录上
      setSelected(new Set())
      onSearchChange?.({ ...search, ...next })
    },
    [onSearchChange, search]
  )

  const params: FileListParams = {
    page,
    size,
    name: search.name || undefined,
    type: search.type,
  }
  const listQuery = useQuery(filesQuery(params))
  const { data, isPending, isFetching } = listQuery
  const list = listState(listQuery)
  const files = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.total_pages ?? 1

  const [previewing, setPreviewing] = React.useState<FileItem | null>(null)
  const [detailing, setDetailing] = React.useState<FileItem | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<FileItem | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [bulkError, setBulkError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const del = useDeleteFiles()
  const upload = useUploadFile()
  const inputRef = React.useRef<HTMLInputElement>(null)

  /**
   * 下载。**不能**做成 `<a href={download_url} download>` —— 那个地址要
   * Authorization 头，裸链接带不上，结果是把 401 的 JSON 当文件存下来。
   */
  const handleDownload = React.useCallback(
    async (f: FileItem) => {
      setActionError(null)
      try {
        const buffer = await fetchBytes(f.download_url)
        const url = URL.createObjectURL(
          new Blob([buffer], { type: f.content_type ?? 'application/octet-stream' })
        )
        const a = document.createElement('a')
        a.href = url
        a.download = f.original_name
        a.click()
        // 不 revoke 会把整个文件的字节留在内存里直到刷新页面
        URL.revokeObjectURL(url)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : t('下载失败'))
      }
    },
    [t]
  )

  const handlePickFiles = React.useCallback(
    async (picked: FileList | null) => {
      if (!picked?.length) return
      setActionError(null)
      // 逐个串行传：并发上传会同时命中「整个 body 先收完才校验大小」那条，
      // 几个大文件一起来会把内存顶起来（file_ops.py 的注释里写了）
      for (const file of Array.from(picked)) {
        try {
          await upload.mutateAsync(file)
        } catch (e) {
          // 一个失败不该中断其余的，但必须让用户看见（硬纪律 9）
          setActionError(
            t('{{name}} 上传失败：{{err}}', {
              name: file.name,
              err: e instanceof Error ? e.message : t('未知错误'),
            })
          )
        }
      }
      // 清掉 input 的值，否则连续选同一个文件不会触发 change
      if (inputRef.current) inputRef.current.value = ''
    },
    [t, upload]
  )

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const actions: FileActions = React.useMemo(
    () => ({
      onPreview: setPreviewing,
      onDownload: (f) => void handleDownload(f),
      onDetail: setDetailing,
      onDelete: setPendingDelete,
    }),
    [handleDownload]
  )

  const selectedIds = [...selected]
  const selectedSize = files.filter((f) => selected.has(f.id)).reduce((n, f) => n + f.size, 0)
  const hasFilter = Boolean(search.name || search.type)
  const clearFilters = () => patch({ name: undefined, type: undefined, page: undefined })

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      {/* content-scroll:* —— 内容区滚动模式下把整块撑满可用高度，
          于是下面 file-content 那一层变成滚动区：工具栏、左侧分类、分页条都钉住 */}
      <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0">
        <PageHeader
          title={t('文件管理')}
          description={t('系统上传文件的统一入口，支持预览、下载与批量清理。')}
        />

        {/* min-w-0 是关键：不给的话 flex 项按内容算最小宽度，
            长文件名会把整页顶出横向滚动条（CLAUDE.md 那条「min-width:auto 是元凶」） */}
        <div className="flex min-w-0 flex-1 gap-4 md:gap-6 content-scroll:min-h-0">
          <FileRail
            value={search.type}
            onChange={(next) => patch({ type: next, page: undefined })}
            className="hidden w-44 shrink-0 md:flex"
          />

          <div className="flex min-w-0 flex-1 flex-col gap-3 content-scroll:min-h-0">
            {/* 工具栏 */}
            <div className="flex flex-wrap items-center gap-2">
              <TextFilter
                value={search.name ?? ''}
                placeholder={t('搜索文件名…')}
                testId="filter-name"
                width="w-56"
                onCommit={(v) => patch({ name: v || undefined, page: undefined })}
              />
              {hasFilter && <ResetButton onClick={clearFilters} />}

              <div className="ms-auto flex items-center gap-2">
                {selectedIds.length > 0 && (
                  <>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {t('已选 {{n}} 项', { n: selectedIds.length })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(new Set())}
                      data-testid="clear-selection"
                    >
                      <IconX className="size-4" />
                      {t('取消选择')}
                    </Button>
                    <Can perm="sys:file:del">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={del.isPending}
                        data-testid="bulk-delete"
                        onClick={() => {
                          setBulkError(null)
                          setBulkOpen(true)
                        }}
                      >
                        <IconTrash className="size-4" />
                        {t('删除')}
                      </Button>
                    </Can>
                    <Separator orientation="vertical" className="h-6" />
                  </>
                )}

                <ToggleGroup
                  value={[view]}
                  onValueChange={(v) => {
                    const next = (v as string[])[0]
                    // ToggleGroup 允许全部取消 —— 那时保持当前视图，
                    // 不然会渲染出一个「既不是宫格也不是列表」的空白区
                    if (next === 'grid' || next === 'list') patch({ view: next })
                  }}
                  className="shrink-0"
                >
                  <ToggleGroupItem value="grid" aria-label={t('宫格视图')} data-testid="view-grid">
                    <IconLayoutGrid className="size-4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="list" aria-label={t('列表视图')} data-testid="view-list">
                    <IconLayoutList className="size-4" />
                  </ToggleGroupItem>
                </ToggleGroup>

                <Can perm="sys:file:upload">
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    className="hidden"
                    data-testid="file-input"
                    onChange={(e) => void handlePickFiles(e.target.files)}
                  />
                  <Button
                    size="sm"
                    disabled={upload.isPending}
                    data-testid="upload-file"
                    onClick={() => inputRef.current?.click()}
                  >
                    <IconUpload className="size-4" />
                    {upload.isPending ? t('上传中…') : t('上传文件')}
                  </Button>
                </Can>
              </div>
            </div>

            {actionError && (
              <p
                role="alert"
                data-testid="file-error"
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {actionError}
              </p>
            )}

            {/* 内容区。后台取数时整块降透明，但**不换成骨架** ——
                换掉会让工具栏和分页条在数据回来时凭空跳一下 */}
            <div
              className={cn(
                'flex-1',
                // 真正滚的那一层。overflow-x-hidden 不能省 —— 只写 y 的话
                // 另一轴的 visible 会计算成 auto，白得一条横向滚动条
                'content-scroll:min-h-0 content-scroll:overflow-y-auto content-scroll:overflow-x-hidden',
                isFetching && !isPending && 'opacity-60 transition-opacity'
              )}
              aria-busy={isFetching}
              data-testid="file-content"
              data-fetching={isFetching}
            >
              {isPending ? (
                <GridSkeleton view={view} />
              ) : list.error ? (
                /* 🔴 排在空态前面 —— 否则接口挂了会显示成「还没有文件」（硬纪律 9） */
                <QueryError error={list.error} onRetry={list.onRetry} testId="file-error" />
              ) : files.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16">
                  <p className="text-sm text-muted-foreground">
                    {hasFilter ? t('没有匹配的文件') : t('还没有文件')}
                  </p>
                  {hasFilter && (
                    <ResetButton
                      variant="outline"
                      testId="empty-clear-filter"
                      label={t('清除筛选')}
                      onClick={clearFilters}
                    />
                  )}
                </div>
              ) : view === 'grid' ? (
                <FileGrid files={files} selected={selected} onToggle={toggle} actions={actions} />
              ) : (
                <FileList files={files} selected={selected} onToggle={toggle} actions={actions} />
              )}
            </div>

            {/* 分页条复用 DataTable 的那一个，外观与全站一致 */}
            <DataTablePagination
              pageIndex={page - 1}
              pageCount={totalPages}
              pageSize={size}
              selectedCount={selectedIds.length}
              totalCount={total}
              pageSizeOptions={[24, 48, 96]}
              onPageChange={(i) => patch({ page: i === 0 ? undefined : i + 1 })}
              onPageSizeChange={(s) => patch({ size: s, page: undefined })}
            />
          </div>
        </div>
      </div>

      <FilePreviewDialog
        file={previewing}
        onOpenChange={(o) => !o && setPreviewing(null)}
        onDownload={(f) => void handleDownload(f)}
      />

      <FileDetailSheet
        file={detailing}
        onOpenChange={(o) => !o && setDetailing(null)}
        onPreview={(f) => {
          setDetailing(null)
          setPreviewing(f)
        }}
        onDownload={(f) => void handleDownload(f)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除文件')}
        description={
          pendingDelete
            ? t('确定删除「{{name}}」吗？磁盘文件与所有业务关联会一并删除，此操作不可撤销。', {
                name: pendingDelete.original_name,
              })
            : ''
        }
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          await del.mutateAsync([pendingDelete.id])
          setPendingDelete(null)
        }}
      />

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t('批量删除文件')}
        description={
          bulkError
            ? t('{{err}}（已删除的不会回滚）', { err: bulkError })
            : t('确定删除选中的 {{n}} 个文件（共 {{size}}）吗？磁盘文件与业务关联会一并删除，此操作不可撤销。', {
                n: selectedIds.length,
                size: formatBytes(selectedSize),
              })
        }
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          try {
            await del.mutateAsync(selectedIds)
            setSelected(new Set())
            setBulkOpen(false)
          } catch (e) {
            // 失败要留在弹窗里说清楚，不要静默关闭
            setBulkError(e instanceof Error ? e.message : t('删除失败'))
          }
        }}
      />
    </div>
  )
}

function GridSkeleton({ view }: { view: FileView }) {
  if (view === 'list') {
    return (
      <div className="flex flex-col gap-px rounded-lg border p-px">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
      {Array.from({ length: 16 }).map((_, i) => (
        <Skeleton key={i} className="h-[136px] w-full rounded-lg" />
      ))}
    </div>
  )
}
