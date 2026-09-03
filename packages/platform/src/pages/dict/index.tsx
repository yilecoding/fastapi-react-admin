import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper, useTable,
  type ColumnVisibilityState, type RowSelectionState,
} from '@tanstack/react-table'
import {
  IconDotsVertical, IconPencil, IconPlus, IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable } from '@admin/ui/components/data-table'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { MasterList, type MasterListItem } from '../_shared/master-list'
import { BulkBar, RefreshButton, ResetButton, TextFilter } from '../_shared/filters'
import { logFeatures as features } from '../_shared/log-features'
import { buildSelectColumn } from '../_shared/select-column'
import { StatusBadge } from '../_shared/status'
import {
  COLOR_CLASS, dictKeys, dictDatasQuery, dictTypesQuery,
  useDeleteDictDatas, useDeleteDictTypes, type DictData, type DictType,
} from './api'
import { DictDataSheet, DictTypeSheet } from './forms'
import { listState } from '../_shared/list-query'
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

  const qc = useQueryClient()

  // ── 左：类型（一次取全，前端过滤） ──
  const typesQuery = useQuery(dictTypesQuery({ page: 1, size: TYPE_PAGE_SIZE }))
  const { data: typesPage, isPending: loadingTypes } = typesQuery
  const typesState = listState(typesQuery)
  // ⚠️ **`?? []` 要包进 useMemo**：不包的话每次渲染都是**新数组**，而它是下面
  // 那个 useMemo 的依赖 —— 于是那个 memo 从来没生效过（每次都重算）。
  // 这不报错、只是白写了一个 memo，`exhaustive-deps` 正好抓这个。
  const types = React.useMemo(() => typesPage?.items ?? [], [typesPage?.items])
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

  // 前端过滤：类型一次取全，所以搜索能同时命中**名称和编码**，且是即时的
  //（角色 / 数据范围那两栏是服务端按名称搜 —— 它们的量会长，取不全）
  const typeItems = React.useMemo<MasterListItem[]>(() => {
    const q = typeQ.trim().toLowerCase()
    const hit = q ? types.filter((ty) => `${ty.name} ${ty.code}`.toLowerCase().includes(q)) : types
    return hit.map((ty) => ({ id: ty.id, title: ty.name, code: ty.code }))
  }, [types, typeQ])

  // 选中项从**全量**列表里找 —— 与左侧搜索无关，搜索不会换掉右侧的数据
  const selectedId = search.type ?? types[0]?.id
  const selected = types.find((ty) => ty.id === selectedId)

  // ── 右：字典项 ──
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const datasQuery = useQuery(
    dictDatasQuery({ page, size, type_id: selectedId, label: search.q || undefined })
  )
  const { data: datasPage, isFetching } = datasQuery
  // 没选类型时这个 query 是 disabled 的（状态一直停在 pending）——
  // `enabled` 一定要传，否则骨架屏会一直转
  const dataList = listState(datasQuery, {
    enabled: Boolean(selectedId),
    onBeforeRefetch: () => setRowSelection({}),
  })
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
  // 单条删除单独一个 mutation 实例——留在弹窗里原地重试，不指望全局兜底
  const rmDataOne = useDeleteDictDatas({ suppressErrorToast: true })
  // 删除失败留在弹窗里说清楚原因（流派一），换了目标要清掉上一次的错误文案
  const [typeError, setTypeError] = React.useState<string | null>(null)
  const [dataError, setDataError] = React.useState<string | null>(null)
  React.useEffect(() => setTypeError(null), [delType])
  React.useEffect(() => setDataError(null), [delData])

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
        {/* content-scroll:lg:* —— 内容区滚动 + 宽屏时整块撑满，两栏各自成定高视区
            （左栏只滚类型、右栏只滚字典项）。窄屏是上下堆叠的，那时照旧整块滚 */}
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:lg:min-h-0 content-scroll:lg:flex-1">
          <PageHeader title={t("数据字典")} description={t("集中管理业务枚举。状态、类型、单位这类下拉选项都放这里。")} />

          {/* 断点用 lg 不用 md：左栏是 w-72 硬宽，768px 下右栏只剩约 176px，
              字典项表格塞不下（角色页踩过同一条，见 CLAUDE.md 主从页一节）。
              不要 items-start —— 定高情形下两栏要等高，sticky 由下面按模式给 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-6 content-scroll:lg:min-h-0">
            {/* ── 左：字典类型 ── 与角色 / 数据范围同一个左栏件 */}
            <MasterList
              idPrefix="type"
              title={t('字典类型')}
              items={typeItems}
              total={typeTotal}
              selectedId={selectedId ?? null}
              onSelect={(id) => patch({ type: id, page: undefined, q: undefined })}
              keyword={typeQ}
              searchPlaceholder="搜索字典类型…"
              onKeyword={setTypeQ}
              loading={loadingTypes}
              error={typesState.error}
              onRetry={typesState.onRetry}
              onRefresh={() => void qc.invalidateQueries({ queryKey: dictKeys.all })}
              onAdd={() => { setEditingType(null); setTypeSheet(true) }}
              addLabel={t('新增字典类型')}
              addPerm="dict:type:add"
              emptyText={t('没有匹配的类型')}
              // 一次只取 TYPE_PAGE_SIZE 条 —— 超出时说清楚，别让人以为就这么多
              footerNote={
                typeTotal > types.length
                  ? t('共 {{total}} 个类型，仅加载前 {{n}} 个', { total: typeTotal, n: types.length })
                  : undefined
              }
              renderActions={(item) => {
                const ty = types.find((x) => x.id === item.id)
                if (!ty) return null
                return (
                  <>
                    <Can perm="dict:type:edit">
                      <DropdownMenuItem onClick={() => { setEditingType(ty); setTypeSheet(true) }}>
                        <IconPencil className="size-4" />{t('编辑')}
                      </DropdownMenuItem>
                    </Can>
                    <Can perm="dict:type:del">
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDelType(ty)}>
                        <IconTrash className="size-4" />{t('删除')}
                      </DropdownMenuItem>
                    </Can>
                  </>
                )
              }}
            />
            {/* ── 右：字典项 ── */}
            <div className="flex min-w-0 flex-1 flex-col gap-3 content-scroll:lg:min-h-0">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
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

              {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 定高情形下
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
                  {...dataList}
                  // 「刷新」和「列」是一组次要图标工具，聚在右端；
                  // 左边的 toolbar 留给筛选与批量条
                  actions={<RefreshButton busy={isFetching} onClick={dataList.onRetry} />}
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
                    onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
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
        open={delType !== null}
        onOpenChange={(o) => !o && setDelType(null)}
        title={t("删除字典类型")}
        description={
          typeError ? (
            <span className="text-destructive">{typeError}</span>
          ) : delType ? (
            t('确定删除「{{name}}」吗？其下的字典项也会一并失效。', { name: delType.name })
          ) : ''
        }
        confirmText={t("删除")} destructive pending={rmType.isPending}
        onConfirm={async () => {
          if (!delType) return
          setTypeError(null)
          try {
            const removingSelected = delType.id === selectedId
            await rmType.mutateAsync([delType.id])
            // 删掉的正是当前选中的 —— 清掉 URL 里的 type，让它回落到第一个
            if (removingSelected) patch({ type: undefined, page: undefined, q: undefined })
            setDelType(null)
          } catch (e) {
            setTypeError(e instanceof Error ? e.message : t('删除失败'))
          }
        }}
      />
      <ConfirmDialog
        open={delData !== null}
        onOpenChange={(o) => !o && setDelData(null)}
        title={t("删除字典项")}
        description={
          dataError ? (
            <span className="text-destructive">{dataError}</span>
          ) : delData ? (
            t('确定删除「{{label}}」吗？', { label: delData.label })
          ) : ''
        }
        confirmText={t("删除")} destructive pending={rmDataOne.isPending}
        onConfirm={async () => {
          if (!delData) return
          setDataError(null)
          try {
            await rmDataOne.mutateAsync([delData.id])
            setDelData(null)
          } catch (e) {
            setDataError(e instanceof Error ? e.message : t('删除失败'))
          }
        }}
      />
      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t("批量删除字典项")}
        description={t('确定删除选中的 {{n}} 个字典项吗？', { n: selectedIds.length })}
        confirmText={t("删除")} destructive pending={rmData.isPending}
        onConfirm={async () => {
          try {
            await rmData.mutateAsync(selectedIds)
            setRowSelection({})
          } finally {
            setBulkOpen(false)
          }
        }}
      />
    </div>
  )
}
