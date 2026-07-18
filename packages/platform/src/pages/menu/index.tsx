import * as React from 'react'
import { menuKey } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle, IconChevronRight, IconChevronsDown, IconChevronsUp,
  IconDotsVertical, IconPencil, IconPlus, IconTrash,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { DataTableSkeletonRows } from '@admin/ui/components/data-table'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { MenuIcon } from '../../shell/icon-registry'
import { PageHeader } from '../../shell/page-header'
import { usePlatform } from '../../shell/platform-context'
import { ResetButton, SelectFilter, StatusFilter, TextFilter } from '../_shared/filters'
import { StatusBadge, TONE_CLASS } from '../_shared/status'
import { useTreeFold } from '../_shared/use-tree-fold'
import {
  MENU_TYPE, MENU_TYPE_ITEMS, countMenus, menuTreeQuery, useDeleteMenu, type Menu,
} from './api'
import { countBroken, isBrokenMenu } from './dead-link'
import { MenuFormSheet } from './form'

/**
 * 菜单管理 —— 平台里最复杂的一页。
 *
 * 四个难点：树形表格、五种类型的动态表单、图标选择器、路由地址对齐。
 * 最后一个是关键：`path` 做成**下拉选择**（选项来自前端真实路由），
 * 而不是自由输入 —— Vue 那套「菜单配错组件路径导致白屏」在这里不可能发生。
 *
 * 排序目前用 `sort` 数值字段。树内拖拽排序是刻意没做的：
 * 树形 DnD 复杂度远高于列表，而它带来的价值只是省去改一个数字。
 */
export type MenuPageSearch = {
  title?: string
  status?: number
  type?: number
  /** 'all' = 默认全折叠（细粒度展开状态见 useTreeFold） */
  fold?: 'all'
  /** 只看死链 —— 标题栏那个「N 个死链」徽标点一下就是它 */
  broken?: boolean
}

const TYPE_FILTER_ITEMS = { all: '全部类型', ...MENU_TYPE_ITEMS }

const TYPE_BADGE: Record<number, 'secondary' | 'outline'> = {
  0: 'secondary', 1: 'outline', 2: 'outline', 3: 'outline', 4: 'outline',
}

export function MenuPage({
  search = {},
  onSearchChange,
}: {
  search?: MenuPageSearch
  onSearchChange?: (n: MenuPageSearch) => void
}) {
  const { t } = useTranslation()
  const patch = (n: Partial<MenuPageSearch>) => onSearchChange?.({ ...search, ...n })
  const { isValidPath } = usePlatform()

  const { data: tree = [], isPending, isFetching } = useQuery(
    menuTreeQuery({ title: search.title || undefined, status: search.status })
  )

  const [sheet, setSheet] = React.useState(false)
  const [editing, setEditing] = React.useState<Menu | null>(null)
  const [presetParent, setPresetParent] = React.useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Menu | null>(null)
  const del = useDeleteMenu()

  const foldAll = search.fold === 'all'
  const { isOpen, toggle } = useTreeFold(foldAll)

  // 类型 / 死链过滤都在前端做（后端只支持 title + status）。
  // 命中的节点要连着祖先链一起留下，否则树会断成孤立的行。
  const shown = React.useMemo(() => {
    const byType = search.type !== undefined
    const byBroken = search.broken === true
    if (!byType && !byBroken) return tree
    const walk = (list: Menu[]): Menu[] => {
      const out: Menu[] = []
      for (const m of list) {
        const kids = walk(m.children ?? [])
        const hit =
          (!byType || m.type === search.type) && (!byBroken || isBrokenMenu(m, isValidPath))
        if (hit || kids.length) out.push({ ...m, children: kids })
      }
      return out
    }
    return walk(tree)
  }, [tree, search.type, search.broken, isValidPath])

  const total = React.useMemo(() => countMenus(tree), [tree])
  const broken = React.useMemo(() => countBroken(tree, isValidPath), [tree, isValidPath])
  const shownTotal = React.useMemo(() => countMenus(shown), [shown])
  const hasFilter = Boolean(
    search.title || search.status !== undefined || search.type !== undefined || search.broken
  )

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* content-scroll:* —— 「内容区滚动」模式下这一块撑满可用高度，
              于是里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，只有行滚。
              整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）。 */}
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t("菜单管理")} description={t("侧边栏结构与权限标识的来源。路由地址从前端已有路由中选，填不错。")} />

          <div className="flex flex-wrap items-center gap-2">
            <TextFilter
              value={search.title ?? ''}
              placeholder={t("搜索菜单标题…")}
              testId="filter-title"
              onCommit={(v) => patch({ title: v || undefined })}
            />
            <SelectFilter
              value={search.type}
              items={TYPE_FILTER_ITEMS}
              testId="filter-type"
              onChange={(v) => patch({ type: v === undefined ? undefined : Number(v) })}
            />
            <StatusFilter value={search.status} onChange={(v) => patch({ status: v })} />
            {hasFilter && (
              <ResetButton
                onClick={() =>
                  patch({ title: undefined, status: undefined, type: undefined, broken: undefined })
                }
              />
            )}
            <Button
              variant="outline" size="sm" className="h-8"
              data-testid="toggle-fold"
              onClick={() => patch({ fold: foldAll ? undefined : 'all' })}
            >
              {foldAll ? <IconChevronsDown className="size-4" /> : <IconChevronsUp className="size-4" />}
              {foldAll ? t('展开全部') : t('折叠全部')}
            </Button>
            <span className="ms-auto flex items-center gap-2 text-sm text-muted-foreground">
              <span data-testid="menu-total">
                {hasFilter ? t('{{shown}} / {{total}} 项', { shown: shownTotal, total }) : t('共 {{n}} 项', { n: total })}
              </span>
              {broken > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-pressed={search.broken === true}
                        onClick={() => patch({ broken: search.broken ? undefined : true })}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1',
                          TONE_CLASS.warning,
                          search.broken && 'ring-2 ring-amber-500/60'
                        )}
                      />
                    }
                    data-testid="broken-count"
                  >
                    <IconAlertTriangle className="size-3" />{t('{{n}} 个死链', { n: broken })}
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('这些菜单的 path 在前端路由里不存在，侧边栏会跳过它们。')}
                    {search.broken ? t('点一下取消筛选') : t('点一下只看它们')}
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
            <Can perm="sys:menu:add">
              <Button size="sm" data-testid="add-menu"
                      onClick={() => { setEditing(null); setPresetParent(null); setSheet(true) }}>
                <IconPlus className="size-4" />{t('新增菜单')}
              </Button>
            </Can>
          </div>

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
            data-testid="menu-table"
            aria-busy={isFetching}
          >
            <Table>
              {/* 吸顶表头。`bg-muted` 不能省（透明的话滚上来的行会从底下透出来），
                  inset 阴影补那条分隔线 —— collapse 表格里 thead 的 border 会跟着滚走 */}
              <TableHeader className="sticky top-0 z-10 bg-muted shadow-[inset_0_-1px_0_var(--border)]">
                <TableRow>
                  <TableHead className="min-w-56">{t('菜单标题')}</TableHead>
                  <TableHead>{t('类型')}</TableHead>
                  <TableHead>{t('路由地址')}</TableHead>
                  <TableHead>{t('权限标识')}</TableHead>
                  <TableHead>{t('排序')}</TableHead>
                  <TableHead>{t('状态')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <DataTableSkeletonRows rows={8} columns={7} />
                ) : shown.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {t('没有匹配的菜单')}
                    </TableCell>
                  </TableRow>
                ) : (
                  shown.map((m) => (
                    <MenuRows
                      key={m.id} node={m} depth={0} isOpen={isOpen} isValidPath={isValidPath}
                      onToggle={toggle}
                      onEdit={(x) => { setEditing(x); setPresetParent(null); setSheet(true) }}
                      onAddChild={(pid) => { setEditing(null); setPresetParent(pid); setSheet(true) }}
                      onDelete={setPendingDelete}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <MenuFormSheet
        open={sheet} onOpenChange={setSheet}
        editing={editing} presetParentId={presetParent} tree={tree}
      />

      <ConfirmDialog
        open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("删除菜单")}
        description={pendingDelete ? t('确定删除「{{title}}」吗？其下的子菜单与按钮权限也会一并移除。', { title: pendingDelete.title }) : ''}
        confirmText={t("删除")} destructive pending={del.isPending}
        onConfirm={async () => { if (pendingDelete) { await del.mutateAsync(pendingDelete.id); setPendingDelete(null) } }}
      />
    </div>
  )
}

function MenuRows({
  node, depth, isOpen, isValidPath, onToggle, onEdit, onAddChild, onDelete,
}: {
  node: Menu
  depth: number
  isOpen: (id: string) => boolean
  isValidPath: (p: string) => boolean
  onToggle: (id: string) => void
  onEdit: (m: Menu) => void
  onAddChild: (parentId: string) => void
  onDelete: (m: Menu) => void
}) {
  const { t } = useTranslation()
  const kids = node.children ?? []
  const hasKids = kids.length > 0
  const open = isOpen(node.id)
  const isButton = node.type === MENU_TYPE.BUTTON
  const dead = isBrokenMenu(node, isValidPath)

  return (
    <>
      <TableRow data-testid={`menu-row-${node.name}`}>
        <TableCell>
          <div className="flex items-center gap-1.5" style={{ paddingInlineStart: `${depth * 20}px` }}>
            {hasKids ? (
              <button type="button" onClick={() => onToggle(node.id)}
                      aria-label={open ? t('折叠') : t('展开')} data-testid={`menu-toggle-${node.name}`}
                      className="grid size-4 shrink-0 place-content-center rounded-sm hover:bg-muted">
                <IconChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            {!isButton && <MenuIcon name={node.icon} />}
            {/* 一级 key 用 path（稳定），二级回落到「标题本身即 key」——
                后者覆盖按钮行（type=2 没有 path，标题是「新增」「修改」这类通用词） */}
            <span className={cn('text-sm', isButton ? 'text-muted-foreground' : 'font-medium')}>
              {t(menuKey(node.path), { defaultValue: t(node.title) })}
            </span>
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={TYPE_BADGE[node.type] ?? 'outline'} className="font-normal">
            {t(MENU_TYPE_ITEMS[String(node.type)] ?? String(node.type))}
          </Badge>
        </TableCell>
        <TableCell>
          {isButton ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="flex items-center gap-1.5">
              <code className={cn('text-xs', dead && 'text-amber-700 line-through dark:text-amber-300')}>
                {node.path || '—'}
              </code>
              {dead && (
                <Tooltip>
                  <TooltipTrigger render={<IconAlertTriangle className="size-3.5 shrink-0 cursor-help text-amber-600" />}
                                  data-testid={`menu-dead-${node.name}`} />
                  <TooltipContent>{t('前端没有这个路由，侧边栏会跳过')}</TooltipContent>
                </Tooltip>
              )}
            </span>
          )}
        </TableCell>
        <TableCell>
          {node.perms
            ? <code className="rounded bg-muted px-1 text-[11px]">{node.perms}</code>
            : <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell className="text-sm tabular-nums text-muted-foreground">{node.sort}</TableCell>
        <TableCell><StatusBadge value={node.status} /></TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: node.title })} />}
              data-testid={`menu-actions-${node.name}`}
            >
              <IconDotsVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              {!isButton && (
                <Can perm="sys:menu:add">
                  <DropdownMenuItem onClick={() => onAddChild(node.id)} data-testid={`menu-addchild-${node.name}`}>
                    <IconPlus className="size-4" />{t('新增子菜单')}
                  </DropdownMenuItem>
                </Can>
              )}
              <Can perm="sys:menu:edit">
                <DropdownMenuItem onClick={() => onEdit(node)} data-testid={`menu-edit-${node.name}`}>
                  <IconPencil className="size-4" />{t('编辑')}
                </DropdownMenuItem>
              </Can>
              <Can perm="sys:menu:del">
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(node)}
                                  data-testid={`menu-delete-${node.name}`}>
                  <IconTrash className="size-4" />{t('删除')}
                </DropdownMenuItem>
              </Can>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      {hasKids && open &&
        kids.map((c) => (
          <MenuRows key={c.id} node={c} depth={depth + 1} isOpen={isOpen} isValidPath={isValidPath}
                    onToggle={onToggle} onEdit={onEdit} onAddChild={onAddChild} onDelete={onDelete} />
        ))}
    </>
  )
}

