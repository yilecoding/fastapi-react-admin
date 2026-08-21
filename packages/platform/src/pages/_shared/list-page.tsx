import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useTable, type ColumnVisibilityState } from '@tanstack/react-table'

import { DataTable } from '@admin/ui/components/data-table'

import { api, type PageData } from '../../api-client/client'
import { PageHeader } from '../../shell/page-header'
import { ResetButton, SelectFilter, TextFilter } from './filters'
import { DEFAULT_PAGE_SIZE } from './pagination'

/**
 * 只读分页列表的通用外壳（筛选 + 分页 + 展示，无增删改）。
 *
 * ⚠️ 当前**没有调用方**：两个日志页各自长出了统计条、CSV 导出、详情抽屉，
 * 已经从这个工厂里搬出去手写了。留着是给后续的只读列表页（操作记录之类）用的，
 * 真到那时若仍不合身，删掉比硬套更好。
 *
 * 约束同样适用：组件 router-独立，search 走 props，视图状态进 URL。
 */
export type FilterSpec =
  | { kind: 'text'; key: string; placeholder: string; width?: string }
  | { kind: 'select'; key: string; items: Record<string, string>; width?: string }

export type ListPageConfig<T> = {
  title: string
  description?: string
  /** 接口路径，如 `/api/v1/logs/login` */
  endpoint: string
  /** react-query key 前缀 */
  queryKey: readonly string[]
  filters: FilterSpec[]
  buildColumns: () => unknown[]
  columnLabels?: Record<string, string>
  /** TanStack Table v9 的 tableFeatures() 返回值 */
  features: any
  emptyMessage?: string
  /** 行主键，默认 `id` */
  getRowId?: (row: T) => string
}

export type ListPageSearch = Record<string, string | number | null | undefined>

export function createListPage<T extends { id: string }>(cfg: ListPageConfig<T>) {
  function ListPage({
    search = {},
    onSearchChange,
  }: {
    search?: ListPageSearch
    onSearchChange?: (next: ListPageSearch) => void
  }) {
    // 配置对象是模块级常量（`createListPage({ title: '…' })`），拿不到 hook ——
    // 但「中文原文即 key」，所以在渲染处 t(变量) 就够了
    const { t } = useTranslation()
    const page = Number(search.page ?? 1)
    const size = Number(search.size ?? DEFAULT_PAGE_SIZE)

    const patch = React.useCallback(
      (next: ListPageSearch) => onSearchChange?.({ ...search, ...next }),
      [onSearchChange, search]
    )

    const qs = React.useMemo(() => {
      const s = new URLSearchParams()
      s.set('page', String(page))
      s.set('size', String(size))
      for (const f of cfg.filters) {
        const v = search[f.key]
        if (v !== undefined && v !== '') s.set(f.key, String(v))
      }
      return s.toString()
    }, [page, size, search])

    const { data, isPending, isFetching } = useQuery({
      queryKey: [...cfg.queryKey, qs],
      queryFn: () => api.GET<PageData<T>>(`${cfg.endpoint}?${qs}`),
      placeholderData: (prev) => prev,
    })

    const rows = data?.items ?? []
    const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})

    const columns = React.useMemo(() => cfg.buildColumns(), [])

    const table = useTable({
      features: cfg.features,
      data: rows,
      columns: columns as never,
      state: { columnVisibility },
      getRowId: (row: T) => cfg.getRowId?.(row) ?? row.id,
      manualPagination: true,
      rowCount: data?.total ?? 0,
      // 只读列表没有批量操作 —— 不开行选中，否则分页条上的「已选 N 项」永远是 0
      enableRowSelection: false,
      onColumnVisibilityChange: setColumnVisibility,
    })

    const hasFilter = cfg.filters.some((f) => search[f.key] !== undefined && search[f.key] !== '')

    return (
      <div className="flex flex-1 flex-col content-scroll:min-h-0">
        <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
          <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
            <PageHeader
              title={t(cfg.title)}
              description={cfg.description ? t(cfg.description) : undefined}
            />

            <div data-testid="list-table" data-fetching={isFetching}>
              <DataTable
                table={table}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                columnLabels={cfg.columnLabels}
                emptyMessage={cfg.emptyMessage ? t(cfg.emptyMessage) : undefined}
                loading={isPending}
                busy={isFetching && !isPending}
                toolbar={
                  <>
                    {cfg.filters.map((f) =>
                      f.kind === 'text' ? (
                        <TextFilter
                          key={f.key}
                          value={(search[f.key] as string) ?? ''}
                          placeholder={f.placeholder}
                          testId={`filter-${f.key}`}
                          width={f.width ?? 'w-44'}
                          onCommit={(v) => patch({ [f.key]: v || undefined, page: undefined })}
                        />
                      ) : (
                        <SelectFilter
                          key={f.key}
                          value={search[f.key] ?? undefined}
                          items={f.items}
                          testId={`filter-${f.key}`}
                          width={f.width ?? 'w-28'}
                          onChange={(v) => patch({ [f.key]: v, page: undefined })}
                        />
                      )
                    )}
                    {hasFilter && (
                      <ResetButton
                        onClick={() =>
                          patch({
                            ...Object.fromEntries(cfg.filters.map((f) => [f.key, undefined])),
                            page: undefined,
                          })
                        }
                      />
                    )}
                  </>
                }
                pagination={{
                  pageIndex: page - 1,
                  pageCount: data?.total_pages ?? 1,
                  pageSize: size,
                  totalCount: data?.total ?? 0,
                  onPageChange: (i) => patch({ page: i + 1 }),
                  onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }
  ListPage.displayName = `ListPage(${cfg.title})`
  return ListPage
}
