import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTable, type RowSelectionState } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { IconPlus } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTable } from '@admin/ui/components/data-table'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import {
  BulkBar, ResetButton, SelectFilter, StatusFilter, TextFilter,
} from '../_shared/filters'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import {
  allRolesQuery, deptTreeQuery, flattenDepts,
  usersQuery, useDeleteUser, useDeleteUsers, type User, type UserListParams,
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
 * 工具栏三件（TextFilter / StatusFilter / ResetButton）与状态药丸都来自
 * `pages/_shared/`，不要在页面里重抄 —— 抄一次就多一处漂移源。
 */
export type UserPageSearch = {
  page?: number
  size?: number
  username?: string
  status?: number
  /** 后端 `GET /sys/users` 本来就支持 phone / dept / role，页面上原先只暴露了 username + status */
  phone?: string
  dept?: string
  role?: string
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

  const params: UserListParams = {
    page,
    size,
    username: search.username || undefined,
    phone: search.phone || undefined,
    status: search.status,
    dept: search.dept || undefined,
    role: search.role || undefined,
  }
  const { data, isPending, isFetching } = useQuery(usersQuery(params))
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.total_pages ?? 1

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<User | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<User | null>(null)
  // 只存 id，用户对象每次从最新的 rows 里取 —— 存快照的话，
  // 切换权限后列表已经 refetch 了，抽屉里的开关还显示旧值（实测踩过）
  const [securityId, setSecurityId] = React.useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const del = useDeleteUser()
  const delMany = useDeleteUsers()
  const [bulkError, setBulkError] = React.useState<string | null>(null)

  const handleEdit = React.useCallback((u: User) => {
    setEditing(u)
    setSheetOpen(true)
  }, [])

  const columns = React.useMemo(
    () => buildColumns(handleEdit, setPendingDelete, (u) => setSecurityId(u.id), t),
    [handleEdit, t]
  )

  // 部门/角色下拉的选项。两个查询都是长缓存的全量表，表单里也在用。
  // ⚠️ 后端的 dept 是**精确匹配** `dept_id`（`crud_user.py:109`），不含子部门 ——
  // 选了父部门只会得到直属该部门的人，不是整棵子树。要改语义得先改后端。
  const { data: deptTree = [] } = useQuery(deptTreeQuery)
  const { data: roles = [] } = useQuery(allRolesQuery)
  const deptItems = React.useMemo(
    () => ({
      all: t('全部部门'),
      // Base UI 的 Select 关闭态靠 items 映射显示标签，缺了就显示雪花 ID
      ...Object.fromEntries(flattenDepts(deptTree).map((d) => [d.id, d.label])),
    }),
    [deptTree, t]
  )
  const roleItems = React.useMemo(
    () => ({ all: t('全部角色'), ...Object.fromEntries(roles.map((r) => [r.id, r.name])) }),
    [roles, t]
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
  const hasFilter = Boolean(
    search.username || search.phone || search.status !== undefined || search.dept || search.role
  )
  const clearFilters = () =>
    patch({
      username: undefined, phone: undefined, status: undefined,
      dept: undefined, role: undefined, page: undefined,
    })

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t("用户管理")} description={t("管理后台账号、部门归属与角色分配。")} />

          {/* 这一层只为 E2E 定位而存在，但它在链路上 —— 内容区滚动模式下
              也要变成能收缩的列向 flex，否则约束传不到 DataTable */}
          <div
            data-testid="user-table"
            data-fetching={isFetching}
            className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
          >
            <DataTable
              table={table}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
              columnLabels={COLUMN_LABELS}
              emptyMessage={t("没有匹配的用户")}
              emptyAction={
                hasFilter ? (
                  <ResetButton
                    variant="outline" testId="empty-clear-filter" label={t("清除筛选")}
                    onClick={clearFilters}
                  />
                ) : undefined
              }
              loading={isPending}
              busy={isFetching && !isPending}
              actions={
                <Can perm="sys:user:add">
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
                </Can>
              }
              toolbar={
                <>
                  <TextFilter
                    value={search.username ?? ''}
                    placeholder={t("搜索用户名…")}
                    testId="filter-username"
                    width="w-44"
                    onCommit={(v) => patch({ username: v || undefined, page: undefined })}
                  />
                  <TextFilter
                    value={search.phone ?? ''}
                    placeholder={t("搜索手机号…")}
                    testId="filter-phone"
                    width="w-36"
                    onCommit={(v) => patch({ phone: v || undefined, page: undefined })}
                  />
                  <SelectFilter
                    value={search.dept}
                    items={deptItems}
                    testId="filter-dept"
                    width="min-w-32"
                    onChange={(v) => patch({ dept: v, page: undefined })}
                  />
                  <SelectFilter
                    value={search.role}
                    items={roleItems}
                    testId="filter-role"
                    width="min-w-32"
                    onChange={(v) => patch({ role: v, page: undefined })}
                  />
                  <StatusFilter
                    value={search.status}
                    onChange={(v) => patch({ status: v, page: undefined })}
                  />
                  {hasFilter && <ResetButton onClick={clearFilters} />}
                  <Can perm="sys:user:del">
                    <BulkBar
                      count={selectedIds.length}
                      pending={delMany.isPending}
                      onDelete={() => {
                        setBulkError(null)
                        setBulkOpen(true)
                      }}
                    />
                  </Can>
                </>
              }
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

      <UserFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />
      <UserSecuritySheet
        open={securityId !== null}
        onOpenChange={(o) => !o && setSecurityId(null)}
        user={rows.find((r) => r.id === securityId) ?? null}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("删除用户")}
        description={
          pendingDelete
            ? t('确定删除「{{who}}」吗？此操作不可撤销。', { who: pendingDelete.nickname || pendingDelete.username })
            : ''
        }
        confirmText={t("删除")}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          await del.mutateAsync(pendingDelete.id)
          setPendingDelete(null)
        }}
      />

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && setBulkOpen(false)}
        title={t("批量删除用户")}
        description={
          bulkError
            ? t('{{err}}（已删除的不会回滚）', { err: bulkError })
            : t('确定删除选中的 {{n}} 个用户吗？此操作不可撤销。', { n: selectedIds.length })
        }
        confirmText={t("删除")}
        destructive
        pending={delMany.isPending}
        onConfirm={async () => {
          try {
            await delMany.mutateAsync(selectedIds)
            setRowSelection({})
            setBulkOpen(false)
          } catch (e) {
            // 部分失败：留在弹窗里把失败条数说清楚，不要静默关闭
            setBulkError(e instanceof Error ? e.message : t('删除失败'))
          }
        }}
      />
    </div>
  )
}
