import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  createColumnHelper, useTable,
  type ColumnVisibilityState, type RowSelectionState,
} from '@tanstack/react-table'
import {
  IconDotsVertical, IconPencil, IconPlus, IconSearch, IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable } from '@admin/ui/components/data-table'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@admin/ui/components/input-group'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { BulkBar, ResetButton, TextFilter } from '../_shared/filters'
import { logFeatures as features } from '../_shared/log-features'
import { buildSelectColumn } from '../_shared/select-column'
import { StatusBadge } from '../_shared/status'
import {
  COLOR_CLASS, dictDatasQuery, dictTypesQuery,
  useDeleteDictDatas, useDeleteDictTypes, type DictData, type DictType,
} from './api'
import { DictDataSheet, DictTypeSheet } from './forms'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

/**
 * 数据字典 —— 左右主从布局。
 *
 * 左侧选类型，右侧列该类型下的字典项。`dict` 是 FBA 的强制插件
 * （`PLUGIN_REQUIRED: ['dict']`），业务里的状态枚举、类型选项都靠它。
 *
 * 三条这里踩过的坑：
 *  1. 类型列表一次取全（`TYPE_PAGE_SIZE`），搜索是**前端过滤** ——
 *     原先按关键字重新请求，每敲一个字符一次网络往返，而且被过滤掉的
 *     当前选中项会让右侧静默切到别的类型的数据（URL 里的 type 还是旧的）。
 *  2. 右侧必须有分页条：字典项超过一页时，只显示总数是翻不过去的。
 *  3. 左栏高度不能写死（原先 `max-h-[520px]`）—— 用 sticky + 视口高度，
 *     列表底端落在视口边缘，而不是把某一项从中间裁断。
 */
export type DictPageSearch = {
  type?: string
  /** 类型列表的搜索词（前端过滤，进 URL 只为刷新后恢复） */
  tq?: string
  q?: string
  page?: number
  size?: number
}

/** 类型一次取多少条。FBA 种子数据是十几条，超出时列表底部会给出提示 */
const TYPE_PAGE_SIZE = 200

const col = createColumnHelper<typeof features, DictData>()

export function DictPage({
  search = {},
  onSearchChange,
}: {
  search?: DictPageSearch
  onSearchChange?: (n: DictPageSearch) => void
}) {
  const { t } = useTranslation()
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})

  const patch = React.useCallback(
    (n: Partial<DictPageSearch>) => {
      setRowSelection({})
      onSearchChange?.({ ...search, ...n })
    },
    [onSearchChange, search]
  )

  // ── 左：类型（一次取全，前端过滤） ──
  const { data: typesPage, isPending: loadingTypes } = useQuery(
    dictTypesQuery({ page: 1, size: TYPE_PAGE_SIZE })
  )
  const types = typesPage?.items ?? []
  const typeTotal = typesPage?.total ?? 0

  const [typeQ, setTypeQ] = React.useState(search.tq ?? '')
  React.useEffect(() => setTypeQ(search.tq ?? ''), [search.tq])
  // 过滤即时生效，URL 慢 300ms 跟上 —— URL 在这里只承担「刷新后恢复」
  React.useEffect(() => {
    if (typeQ === (search.tq ?? '')) return
    // ⚠️ 不能叫 `t` —— 会遮蔽翻译函数（本文件已因此踩过一次）
    const timer = setTimeout(() => patch({ tq: typeQ || undefined }), 300)
    return () => clearTimeout(timer)
  }, [typeQ, search.tq, patch])

  const shownTypes = React.useMemo(() => {
    const q = typeQ.trim().toLowerCase()
    if (!q) return types
    return types.filter((ty) => `${ty.name} ${ty.code}`.toLowerCase().includes(q))
  }, [types, typeQ])

  // 选中项从**全量**列表里找 —— 与左侧搜索无关，搜索不会换掉右侧的数据
  const selectedId = search.type ?? types[0]?.id
  const selected = types.find((ty) => ty.id === selectedId)

  // ── 右：字典项 ──
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const { data: datasPage, isPending: loadingDatas, isFetching } = useQuery(
    dictDatasQuery({ page, size, type_id: selectedId, label: search.q || undefined })
  )
  const datas = datasPage?.items ?? []

  const [typeSheet, setTypeSheet] = React.useState(false)
  const [editingType, setEditingType] = React.useState<DictType | null>(null)
  const [dataSheet, setDataSheet] = React.useState(false)
  const [editingData, setEditingData] = React.useState<DictData | null>(null)
  const [delType, setDelType] = React.useState<DictType | null>(null)
  const [delData, setDelData] = React.useState<DictData | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const rmType = useDeleteDictTypes()
  const rmData = useDeleteDictDatas()

  const columns = React.useMemo(
    () => [
      buildSelectColumn(col, {}, t),
      col.accessor('label', {
        header: t('显示文本'),
        cell: ({ row, getValue }) => (
          <span
            className={cn(
              'inline-flex rounded-full px-2 py-0.5 text-xs ring-1',
              COLOR_CLASS[row.original.color ?? 'default'] ?? COLOR_CLASS.default
            )}
          >
            {getValue()}
          </span>
        ),
      }),
      col.accessor('value', {
        header: t('实际值'),
        cell: ({ getValue }) => <code className="text-xs">{getValue()}</code>,
      }),
      col.accessor('sort', {
        header: t('排序'),
        cell: ({ getValue }) => (
          <span className="text-sm tabular-nums text-muted-foreground">{getValue()}</span>
        ),
      }),
      col.accessor('status', {
        header: t('状态'),
        cell: ({ getValue }) => <StatusBadge value={getValue()} />,
      }),
      col.accessor('remark', {
        header: t('备注'),
        cell: ({ getValue }) => (
          <span className="block max-w-40 truncate text-sm text-muted-foreground" title={getValue() ?? ''}>
            {getValue() || '—'}
          </span>
        ),
      }),
      col.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('操作')}</span>,
        cell: ({ row }) => {
          const d = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: d.label })} />}
                data-testid={`data-actions-${d.value}`}
              >
                <IconDotsVertical className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                <Can perm="dict:data:edit">
                  <DropdownMenuItem onClick={() => { setEditingData(d); setDataSheet(true) }}
                                    data-testid={`data-edit-${d.value}`}>
                    <IconPencil className="size-4" />{t('编辑')}
                  </DropdownMenuItem>
                </Can>
                <Can perm="dict:data:del">
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDelData(d)}
                                    data-testid={`data-delete-${d.value}`}>
                    <IconTrash className="size-4" />{t('删除')}
                  </DropdownMenuItem>
                </Can>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      }),
    ],
    [t]
  )

  const table = useTable({
    features,
    data: datas,
    columns: columns as never,
    state: { columnVisibility, rowSelection },
    getRowId: (d) => d.id,
    manualPagination: true,
    rowCount: datasPage?.total ?? 0,
    enableRowSelection: true,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  })

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader title={t("数据字典")} description={t("集中管理业务枚举。状态、类型、单位这类下拉选项都放这里。")} />

          <div className="flex flex-col gap-4 md:flex-row md:items-start">
            {/* ── 左：字典类型 ── */}
            <div className="flex w-full shrink-0 flex-col gap-2 md:sticky md:top-4 md:max-h-[calc(100dvh-13rem)] md:w-72">
              <div className="flex items-center gap-2">
                <InputGroup className="h-8 flex-1">
                  <InputGroupAddon align="inline-start">
                    <IconSearch className="size-4 text-muted-foreground" />
                  </InputGroupAddon>
                  <InputGroupInput
                    value={typeQ} data-testid="filter-type"
                    placeholder={t("搜索字典类型…")}
                    onChange={(e) => setTypeQ(e.target.value)}
                  />
                </InputGroup>
                <Can perm="dict:type:add">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon" className="size-8 shrink-0"
                          aria-label={t("新增字典类型")} data-testid="add-type"
                          onClick={() => { setEditingType(null); setTypeSheet(true) }}
                        />
                      }
                    >
                      <IconPlus className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t('新增字典类型')}</TooltipContent>
                  </Tooltip>
                </Can>
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border" data-testid="type-list">
                {loadingTypes ? (
                  <div className="flex flex-col gap-1 p-2">
                    {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
                  </div>
                ) : shownTypes.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('没有匹配的类型')}</p>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto p-1">
                    {shownTypes.map((ty) => (
                      <div
                        key={ty.id}
                        role="button"
                        tabIndex={0}
                        data-testid={`type-${ty.code}`}
                        aria-pressed={ty.id === selectedId}
                        onClick={() => patch({ type: ty.id, page: undefined, q: undefined })}
                        onKeyDown={(e) =>
                          (e.key === 'Enter' || e.key === ' ') && patch({ type: ty.id, page: undefined, q: undefined })
                        }
                        className={cn(
                          'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                          ty.id === selectedId
                            ? 'bg-muted font-medium ring-1 ring-border'
                            : 'hover:bg-muted/60'
                        )}
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{ty.name}</span>
                          <code className="truncate text-[11px] text-muted-foreground">{ty.code}</code>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="ghost" size="icon" className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t('操作 {{name}}', { name: ty.name })} />}
                            data-testid={`type-actions-${ty.code}`}
                          >
                            <IconDotsVertical className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-32">
                            <Can perm="dict:type:edit">
                              <DropdownMenuItem onClick={() => { setEditingType(ty); setTypeSheet(true) }}
                                                data-testid={`type-edit-${ty.code}`}>
                                <IconPencil className="size-4" />{t('编辑')}
                              </DropdownMenuItem>
                            </Can>
                            <Can perm="dict:type:del">
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => setDelType(ty)}
                                                data-testid={`type-delete-${ty.code}`}>
                                <IconTrash className="size-4" />{t('删除')}
                              </DropdownMenuItem>
                            </Can>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ))}
                  </div>
                )}
                {/* 一次只取 TYPE_PAGE_SIZE 条 —— 超出时说清楚，别让人以为就这么多 */}
                {typeTotal > types.length && (
                  <p className="border-t px-2 py-1.5 text-[11px] text-muted-foreground" data-testid="type-truncated">
                    {t('共 {{total}} 个类型，仅加载前 {{n}} 个', { total: typeTotal, n: types.length })}
                  </p>
                )}
              </div>
            </div>

            {/* ── 右：字典项 ── */}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium" data-testid="selected-type">
                    {selected?.name ?? t('未选择字典类型')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {selected ? t('{{code}} · 共 {{n}} 项', { code: selected.code, n: datasPage?.total ?? 0 }) : t('先在左侧选一个类型')}
                  </span>
                </div>
                <div className="ms-auto">
                  <Can perm="dict:data:add">
                    <Button size="sm" variant="outline" disabled={!selected} data-testid="add-data"
                            onClick={() => { setEditingData(null); setDataSheet(true) }}>
                      <IconPlus className="size-4" />{t('新增字典项')}
                    </Button>
                  </Can>
                </div>
              </div>

              {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
          <div
            data-testid="data-table"
            data-fetching={isFetching}
            className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
          >
                <DataTable
                  table={table}
                  rows={table.getRowModel().rows}
                  columnCount={columns.length}
                  rowAttributes={(row) => ({ 'data-testid': `data-row-${row.original.value}` })}
                  columnLabels={{
                    // DataTable 在渲染处过 `t(columnLabels[id])`，这里传中文原文即可
                    label: '显示文本', value: '实际值', sort: '排序',
                    status: '状态', remark: '备注',
                  }}
                  emptyMessage={selected ? t('该类型下还没有字典项') : t('请先选择一个字典类型')}
                  emptyAction={
                    search.q ? (
                      <ResetButton
                        variant="outline" testId="empty-clear-filter" label={t("清除筛选")}
                        onClick={() => patch({ q: undefined, page: undefined })}
                      />
                    ) : undefined
                  }
                  // 没选类型时 query 是 disabled 的（状态一直是 pending），
                  // 不加这个判断骨架屏会一直转
                  loading={Boolean(selectedId) && loadingDatas}
                  busy={isFetching && !loadingDatas}
                  toolbar={
                    <>
                      <TextFilter
                        value={search.q ?? ''}
                        placeholder={t("搜索字典项…")}
                        testId="filter-label"
                        onCommit={(v) => patch({ q: v || undefined, page: undefined })}
                      />
                      {search.q && <ResetButton onClick={() => patch({ q: undefined, page: undefined })} />}
                      <Can perm="dict:data:del">
                        <BulkBar
                          count={selectedIds.length}
                          pending={rmData.isPending}
                          onDelete={() => setBulkOpen(true)}
                        />
                      </Can>
                    </>
                  }
                  pagination={{
                    pageIndex: page - 1,
                    pageCount: datasPage?.total_pages ?? 1,
                    pageSize: size,
                    selectedCount: selectedIds.length,
                    totalCount: datasPage?.total ?? 0,
                    onPageChange: (i) => patch({ page: i + 1 }),
                    onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <DictTypeSheet open={typeSheet} onOpenChange={setTypeSheet} editing={editingType} />
      <DictDataSheet
        open={dataSheet} onOpenChange={setDataSheet} editing={editingData}
        typeId={selected?.id ?? ''} typeName={selected?.name ?? ''}
      />

      <ConfirmDialog
        open={delType !== null} onOpenChange={(o) => !o && setDelType(null)}
        title={t("删除字典类型")}
        description={delType ? t('确定删除「{{name}}」吗？其下的字典项也会一并失效。', { name: delType.name }) : ''}
        confirmText={t("删除")} destructive pending={rmType.isPending}
        onConfirm={async () => {
          if (!delType) return
          const removingSelected = delType.id === selectedId
          await rmType.mutateAsync([delType.id])
          setDelType(null)
          // 删掉的正是当前选中的 —— 清掉 URL 里的 type，让它回落到第一个
          if (removingSelected) patch({ type: undefined, page: undefined, q: undefined })
        }}
      />
      <ConfirmDialog
        open={delData !== null} onOpenChange={(o) => !o && setDelData(null)}
        title={t("删除字典项")}
        description={delData ? t('确定删除「{{label}}」吗？', { label: delData.label }) : ''}
        confirmText={t("删除")} destructive pending={rmData.isPending}
        onConfirm={async () => { if (delData) { await rmData.mutateAsync([delData.id]); setDelData(null) } }}
      />
      <ConfirmDialog
        open={bulkOpen} onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t("批量删除字典项")}
        description={t('确定删除选中的 {{n}} 个字典项吗？', { n: selectedIds.length })}
        confirmText={t("删除")} destructive pending={rmData.isPending}
        onConfirm={async () => {
          await rmData.mutateAsync(selectedIds)
          setRowSelection({})
          setBulkOpen(false)
        }}
      />
    </div>
  )
}
