import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTable, type RowSelectionState } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { IconPlus } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'

import { Can, SuperOnly } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { BulkBar, RefreshButton, ResetButton } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { useQuerySearch } from '../_shared/use-query-search'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import {
  allRolesQuery,
  deptTreeQuery,
  flattenDepts,
  userKeys,
  usersQuery,
  useDeleteUser,
  useDeleteUsers,
  type User,
  type UserListParams,
} from './api'
import { COLUMN_LABELS, buildColumns } from './columns'
import { features } from './table-features'
import { UserFormSheet } from './form'
import { UserSecuritySheet } from './security-sheet'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

/**
 * 用户管理 —— **三件套模板的样板页**。
 *
 * 硬纪律（见 CLAUDE.md）：
 *   1. 组件 router-独立：search 从 props 进来，内部不调 Route.useSearch()
 *      （隐藏的 tab 没有 router match 上下文）
 *   2. 视图状态进 URL：筛选/分页放在 search params 里，刷新后可恢复
 *
 * 筛选栏走 `QueryBar` + `_shared/use-query-search`（字段声明式、条件进 URL），
 * 不要在页面里手拼控件和入参映射 —— 抄一次就多一处漂移源。
 */
export type UserPageSearch = {
  page?: number
  size?: number
  /** 以下由 QueryBar 管，键 = FIELDS 里的 key（这一页恰好和接口入参同名） */
  username?: string
  status?: number
  /** 后端 `GET /sys/users` 本来就支持 phone / dept / role，页面上原先只暴露了 username + status */
  phone?: string
  dept?: string
  role?: string
  /** 摆开但还没填值的格子（见 `_shared/use-query-search`） */
  f?: string
  /** 被隐藏的列 id，逗号分隔 */
  hide?: string
}

export function UserPage({
  search = {},
  onSearchChange,
}: {
  search?: UserPageSearch
  onSearchChange?: (next: UserPageSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE

  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  // 列显隐进 URL —— 走 onSearchChange 而不是 patch：隐掉一列不该清掉勾选、也不该跳回第一页
  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )

  // 换页/换筛选就清掉选中：分页在服务端，留着的选中项已经不在可见行里了，
  // 批量删除会打到用户看不见的记录上。
  const patch = React.useCallback(
    (next: Partial<UserPageSearch>) => {
      setRowSelection({})
      onSearchChange?.({ ...search, ...next })
    },
    [onSearchChange, search]
  )

  // 部门/角色下拉的选项。两个查询都是长缓存的全量表，表单里也在用。
  // ⚠️ 后端的 dept 是**精确匹配** `dept_id`（`crud_user.py:109`），不含子部门 ——
  // 选了父部门只会得到直属该部门的人，不是整棵子树。要改语义得先改后端。
  const { data: deptTree = [], isPending: deptPending } = useQuery(deptTreeQuery)
  const { data: roles = [], isPending: rolePending } = useQuery(allRolesQuery)

  /**
   * 可筛字段的声明。
   *
   * 这一页的 `key` 恰好和接口入参同名（`username` / `phone` / `status` / `dept` /
   * `role`），所以不用 `param` 映射 —— 但**它们仍然是两回事**：`key` 是地址栏里的名字，
   * 改接口时只动 `param`，URL 不受影响（日志页就是分开的）。
   *
   * ⚠️ 部门/角色的 value 是**雪花 ID**，声明成字符串 —— 一路到 URL 都不能被
   * `Number()`（硬纪律 6）。`apps/web/src/lib/search-params.ts` 的自定义解析
   * 会让超安全整数范围的纯整数保持字符串，所以 `?dept=2202097973238829056`
   * 读回来还是那一串。
   *
   * 选项还在取的时候给 `optionsLoading` —— 否则是个点开空空如也的下拉，
   * 看起来像「这个部门没了」而不是「还没加载完」。
   */
  const fields = React.useMemo<FilterField[]>(
    () => [
      {
        key: 'username',
        label: '用户名',
        type: 'text',
        group: '账号',
        defaultVisible: true,
        placeholder: '模糊匹配',
      },
      { key: 'phone', label: '手机号', type: 'text', group: '账号', defaultVisible: true },
      {
        key: 'dept',
        label: '部门',
        type: 'select',
        group: '归属',
        defaultVisible: true,
        // 后端的 dept 是**精确匹配** `dept_id`（`crud_user.py:109`），不含子部门
        hint: '不含子部门',
        optionsLoading: deptPending,
        options: flattenDepts(deptTree).map((d) => ({ value: d.id, label: d.label })),
      },
      {
        key: 'role',
        label: '角色',
        type: 'select',
        group: '归属',
        defaultVisible: true,
        optionsLoading: rolePending,
        options: roles.map((r) => ({ value: r.id, label: r.name })),
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        group: '状态',
        defaultVisible: true,
        options: [
          { value: 1, label: '正常' },
          { value: 0, label: '停用' },
        ],
      },
    ],
    [deptTree, deptPending, roles, rolePending]
  )

  /**
   * URL ↔ QueryBar 的胶水。
   *
   * ⚠️ 搜索/重置时要**清掉选中行**：分页在服务端，换了筛选条件之后留着的选中项
   * 已经不在可见行里了，批量删除会打到用户看不见的记录上（原来 `patch` 里做的那件事）。
   */
  const q = useQuerySearch({ fields, search, onSearchChange, keep: ['hide'], refreshKey: userKeys.all })
  const submitQuery = React.useCallback(
    (v: Parameters<typeof q.submit>[0]) => {
      setRowSelection({})
      q.submit(v)
    },
    [q]
  )

  // 接口入参由查询区出（`param` / `rangeParams` 都应用过），页面只补分页
  const params = { page, size, ...q.params } as UserListParams
  const listQuery = useQuery(usersQuery(params))
  const { data, isFetching } = listQuery
  // 刷新/重试前清掉选中：重取回来的行可能已经不在了（见 list-query.ts 的注释）
  const list = listState(listQuery, { onBeforeRefetch: () => setRowSelection({}) })
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.total_pages ?? 1

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<User | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<User | null>(null)
  // 删除失败留在弹窗里说清楚原因（流派一），换了目标要清掉上一次的错误文案。
  // 只对单条删除这么做——批量删除是部分失败语义（allSettled），照旧关弹窗走全局 toast，
  // 留在原地重试对「已经删掉一半」的选中集合没有意义
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  React.useEffect(() => setDeleteError(null), [pendingDelete])
  // 只存 id，用户对象每次从最新的 rows 里取 —— 存快照的话，
  // 切换权限后列表已经 refetch 了，抽屉里的开关还显示旧值（实测踩过）
  const [securityId, setSecurityId] = React.useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const del = useDeleteUser()
  const delMany = useDeleteUsers()

  const handleEdit = React.useCallback((u: User) => {
    setEditing(u)
    setSheetOpen(true)
  }, [])

  const columns = React.useMemo(
    () => buildColumns(handleEdit, setPendingDelete, (u) => setSecurityId(u.id), t),
    [handleEdit, t]
  )

  const table = useTable({
    features,
    data: rows,
    // TanStack Table v9 的列定义数组在混用不同 TValue 时会形成联合类型，
    // 与 useTable 期望的 ColumnDef<..., unknown>[] 不兼容（库的类型方差限制）
    columns: columns as never,
    state: { columnVisibility, rowSelection },
    getRowId: (row) => row.id,
    // 分页/筛选都在服务端 —— 关掉客户端分页，否则会出现「只筛当前页」
    manualPagination: true,
    rowCount: total,
    enableRowSelection: (row) => !row.original.is_superuser,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  })

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
  const hasFilter = countActive(q.applied, fields) > 0
  const clearFilters = React.useCallback(() => {
    setRowSelection({})
    q.reset()
  }, [q])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('用户管理')} description={t('管理后台账号、部门归属与角色分配。')} />

          {/* 查询区和表格是同一个块的两半（筛选 → 结果），gap-4 而不是页面级的 24px；
              这一层也要能收缩，否则「只滚表格行」那条链断在这里 */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={fields}
              value={q.value}
              onChange={q.setValue}
              onSearch={submitQuery}
              onReset={clearFilters}
              applied={q.applied}
              loading={isFetching}
              viewsStorageKey="qb:user"
              actions={
                <>
                  {/* 新增用户后端是 DependsSuperUser（user.py:71），不是权限码校验，
                      按 isSuperuser 直判，别用 <Can perm="..."> 编一个假权限码 */}
                  <SuperOnly>
                    <Button
                      size="sm"
                      data-testid="add-user"
                      onClick={() => {
                        setEditing(null)
                        setSheetOpen(true)
                      }}
                    >
                      <IconPlus className="size-4" />
                      {t('新增用户')}
                    </Button>
                  </SuperOnly>
                  {/* 「列」下拉从 DataTable 搬过来 —— 它自己那一行就整行消失了 */}
                  <RefreshButton busy={isFetching} onClick={list.onRetry} />
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                  {/*
                  批量条放**左组末尾**：选中行时它才出现，左组往右长进空白里，
                  右边的「搜索 / 重置」不会跟着跳。放右组的话每选一次行按钮就位移一次。
                */}
                  <Can perm="sys:user:del">
                    <BulkBar
                      count={selectedIds.length}
                      pending={delMany.isPending}
                      onDelete={() => setBulkOpen(true)}
                    />
                  </Can>
                </>
              }
            />

            {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
            <div
              data-testid="user-table"
              data-fetching={isFetching}
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                columnLabels={COLUMN_LABELS}
                emptyMessage={t('没有匹配的用户')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton
                      variant="outline"
                      testId="empty-clear-filter"
                      label={t('清除筛选')}
                      onClick={clearFilters}
                    />
                  ) : undefined
                }
                {...list}
                pagination={{
                  pageIndex: page - 1,
                  pageCount: totalPages,
                  pageSize: size,
                  selectedCount: selectedIds.length,
                  totalCount: total,
                  onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
                  onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <UserFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />
      <UserSecuritySheet
        open={securityId !== null}
        onOpenChange={(o) => !o && setSecurityId(null)}
        user={rows.find((r) => r.id === securityId) ?? null}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除用户')}
        description={
          deleteError ? (
            <span className="text-destructive">{deleteError}</span>
          ) : pendingDelete ? (
            t('确定删除「{{who}}」吗？此操作不可撤销。', {
              who: pendingDelete.nickname || pendingDelete.username,
            })
          ) : ''
        }
        confirmText={t('删除')}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          setDeleteError(null)
          try {
            await del.mutateAsync(pendingDelete.id)
            setPendingDelete(null)
          } catch (e) {
            setDeleteError(e instanceof Error ? e.message : t('删除失败'))
          }
        }}
      />

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t('批量删除用户')}
        description={t('确定删除选中的 {{n}} 个用户吗？此操作不可撤销。', { n: selectedIds.length })}
        confirmText={t('删除')}
        destructive
        pending={delMany.isPending}
        onConfirm={async () => {
          // 部分失败（已删除的不会回滚）由全局 mutationCache 的 onError 弹 toast
          // 说清楚失败条数，弹窗不用再自己接一份一样的文案
          try {
            await delMany.mutateAsync(selectedIds)
            setRowSelection({})
          } finally {
            setBulkOpen(false)
          }
        }}
      />
    </div>
  )
}
