import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconChevronRight,
  IconChevronsDown,
  IconChevronsUp,
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { DataTableErrorRow, DataTableSkeletonRows } from '@admin/ui/components/data-table'
import { QueryError } from '@admin/ui/components/query-error'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { ResetButton, StatusFilter, TextFilter } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { StatusBadge } from '../_shared/status'
import { useTreeFold } from '../_shared/use-tree-fold'
import { deptTreeQuery, useDeleteDept, type Dept } from './api'
import { DeptFormSheet } from './form'

/**
 * 部门管理 —— 树形表格。
 *
 * 这里没有用 TanStack Table：部门数据本身就是嵌套树且量级很小（几十条），
 * 引入 `rowExpandingFeature` 需要先把树拍平再让它重新分组，绕了一圈。
 * 直接递归渲染 `<TableRow>` 更直观，缩进用 padding-inline-start 表达层级。
 *
 * 权限守卫在路由层（`requirePerm('sys:dept:add')`），
 * 行内操作再用 `<Can>` 做二次门禁 —— 后者只管显隐，真正的拦截在后端。
 */
export type DeptPageSearch = {
  name?: string
  code?: string
  status?: number
  /** 'all' = 默认全折叠（细粒度展开状态见 useTreeFold） */
  fold?: 'all'
}

export function DeptPage({
  search = {},
  onSearchChange,
}: {
  search?: DeptPageSearch
  onSearchChange?: (n: DeptPageSearch) => void
}) {
  const { t } = useTranslation()
  const filters = { name: search.name || undefined, code: search.code || undefined, status: search.status }
  const listQuery = useQuery(deptTreeQuery(filters))
  const { data: tree = [], isPending, isFetching } = listQuery
  const list = listState(listQuery)

  const patch = (n: Partial<DeptPageSearch>) => onSearchChange?.({ ...search, ...n })

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Dept | null>(null)
  const [presetParent, setPresetParent] = React.useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Dept | null>(null)
  const del = useDeleteDept()

  const foldAll = search.fold === 'all'
  const { isOpen, toggle } = useTreeFold(foldAll)

  function openCreate(parentId: string | null) {
    setEditing(null)
    setPresetParent(parentId)
    setSheetOpen(true)
  }
  function openEdit(d: Dept) {
    setEditing(d)
    setPresetParent(null)
    setSheetOpen(true)
  }

  const hasFilter = Boolean(search.name || search.code || search.status !== undefined)
  const total = React.useMemo(() => countNodes(tree), [tree])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t("部门管理")} description={t("组织架构树。数据权限的隔离就建在这棵树上。")} />

          <div className="flex flex-wrap items-center gap-2">
            <TextFilter
              value={search.name ?? ''}
              placeholder={t("搜索部门名称…")}
              testId="filter-name"
              onCommit={(v) => patch({ name: v || undefined })}
            />
            <TextFilter
              value={search.code ?? ''}
              placeholder={t("搜索编码…")}
              testId="filter-code"
              width="w-40"
              onCommit={(v) => patch({ code: v || undefined })}
            />
            <StatusFilter value={search.status} onChange={(v) => patch({ status: v })} />
            {hasFilter && (
              <ResetButton onClick={() => patch({ name: undefined, code: undefined, status: undefined })} />
            )}
            <Button
              variant="outline" size="sm" className="h-8"
              data-testid="toggle-fold"
              onClick={() => patch({ fold: foldAll ? undefined : 'all' })}
            >
              {foldAll ? <IconChevronsDown className="size-4" /> : <IconChevronsUp className="size-4" />}
              {foldAll ? t('展开全部') : t('折叠全部')}
            </Button>
            <span className="ms-auto text-sm text-muted-foreground">{t('共 {{n}} 个部门', { n: total })}</span>
            <Can perm="sys:dept:add">
              <Button size="sm" data-testid="add-dept" onClick={() => openCreate(null)}>
                <IconPlus className="size-4" />
                {t('新增部门')}
              </Button>
            </Can>
          </div>

          {/* 有旧数据可看时（重取失败那种）不抽走表格，错误挂成横幅 */}
          {Boolean(list.error) && tree.length > 0 && (
            <QueryError error={list.error} onRetry={list.onRetry} className="shrink-0" />
          )}

          {/* 加载中也保留表头与工具栏 —— 整块换骨架屏会让筛选栏在加载完成时凭空出现 */}
          <div
            className={cn(
              'overflow-x-auto rounded-lg border transition-opacity',
              // 与 `DataTable` 的表格框同款：内容区滚动模式下变成定高的表格视区。
              // 真正滚的是 `Table` 内部那层 table-container（见 ui/components/table.tsx），
              // 所以这里只负责「变成列向 flex + 把高度传下去」
              'content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col',
              isFetching && !isPending && 'opacity-60'
            )}
            data-testid="dept-table"
            aria-busy={isFetching}
          >
            <Table>
              {/* 吸顶表头。`bg-muted` 不能省（透明的话滚上来的行会从底下透出来），
                  inset 阴影补那条分隔线 —— collapse 表格里 thead 的 border 会跟着滚走 */}
              <TableHeader className="sticky top-0 z-10 bg-muted shadow-[inset_0_-1px_0_var(--border)]">
                <TableRow>
                  <TableHead>{t('部门名称')}</TableHead>
                  <TableHead>{t('编码')}</TableHead>
                  <TableHead>{t('负责人')}</TableHead>
                  <TableHead>{t('联系电话')}</TableHead>
                  <TableHead>{t('排序')}</TableHead>
                  <TableHead>{t('状态')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <DataTableSkeletonRows rows={5} columns={7} />
                ) : list.error && tree.length === 0 ? (
                  /* 🔴 排在空态前面 —— 否则接口挂了会显示成「没有匹配的部门」（硬纪律 9） */
                  <DataTableErrorRow columnCount={7} error={list.error} onRetry={list.onRetry} />
                ) : tree.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {t('没有匹配的部门')}
                    </TableCell>
                  </TableRow>
                ) : (
                  tree.map((d) => (
                    <DeptRows
                      key={d.id} node={d} depth={0} isOpen={isOpen}
                      onToggle={toggle} onEdit={openEdit} onAddChild={openCreate}
                      onDelete={setPendingDelete}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <DeptFormSheet
        open={sheetOpen} onOpenChange={setSheetOpen}
        editing={editing} presetParentId={presetParent} tree={tree}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("删除部门")}
        description={
          pendingDelete
            ? t('确定删除「{{name}}」吗？若该部门下仍有子部门或用户，后端会拒绝。', { name: pendingDelete.name })
            : ''
        }
        confirmText={t("删除")} destructive pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          await del.mutateAsync(pendingDelete.id)
          setPendingDelete(null)
        }}
      />
    </div>
  )
}

function DeptRows({
  node, depth, isOpen, onToggle, onEdit, onAddChild, onDelete,
}: {
  node: Dept
  depth: number
  isOpen: (id: string) => boolean
  onToggle: (id: string) => void
  onEdit: (d: Dept) => void
  onAddChild: (parentId: string) => void
  onDelete: (d: Dept) => void
}) {
  const kids = node.children ?? []
  const { t } = useTranslation()
  const hasKids = kids.length > 0
  const open = isOpen(node.id)

  return (
    <>
      <TableRow data-testid={`dept-row-${node.name}`}>
        <TableCell>
          <div className="flex items-center gap-1" style={{ paddingInlineStart: `${depth * 20}px` }}>
            {hasKids ? (
              <button type="button" onClick={() => onToggle(node.id)}
                      aria-label={open ? t('折叠') : t('展开')} data-testid={`dept-toggle-${node.name}`}
                      className="grid size-4 shrink-0 place-content-center rounded-sm hover:bg-muted">
                <IconChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span className="text-sm font-medium">{node.name}</span>
          </div>
        </TableCell>
        <TableCell>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{node.code}</code>
        </TableCell>
        <TableCell className="text-sm">{node.leader || <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className="text-sm tabular-nums">{node.phone || <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className="text-sm tabular-nums text-muted-foreground">{node.sort}</TableCell>
        <TableCell><StatusBadge value={node.status} /></TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: node.name })} />}
              data-testid={`dept-actions-${node.name}`}
            >
              <IconDotsVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <Can perm="sys:dept:add">
                <DropdownMenuItem onClick={() => onAddChild(node.id)} data-testid={`dept-addchild-${node.name}`}>
                  <IconPlus className="size-4" />{t('新增子部门')}
                </DropdownMenuItem>
              </Can>
              <Can perm="sys:dept:edit">
                <DropdownMenuItem onClick={() => onEdit(node)} data-testid={`dept-edit-${node.name}`}>
                  <IconPencil className="size-4" />{t('编辑')}
                </DropdownMenuItem>
              </Can>
              <Can perm="sys:dept:del">
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(node)}
                                  data-testid={`dept-delete-${node.name}`}>
                  <IconTrash className="size-4" />{t('删除')}
                </DropdownMenuItem>
              </Can>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      {hasKids && open &&
        kids.map((c) => (
          <DeptRows key={c.id} node={c} depth={depth + 1} isOpen={isOpen}
                    onToggle={onToggle} onEdit={onEdit} onAddChild={onAddChild} onDelete={onDelete} />
        ))}
    </>
  )
}

function countNodes(list: Dept[]): number {
  return list.reduce((n, d) => n + 1 + countNodes(d.children ?? []), 0)
}
