import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { menuKey } from '@admin/i18n'
import {
  IconAlertTriangle, IconChevronDown, IconChevronRight, IconDeviceFloppy, IconFoldDown,
  IconFoldUp, IconLoader2, IconRotate, IconSearch,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { DataTableSkeletonRows } from '@admin/ui/components/data-table'
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@admin/ui/components/input-group'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@admin/ui/components/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import { usePerm } from '../../auth/use-perm'
import { MenuIcon } from '../../shell/icon-registry'
import { MENU_TYPE_ITEMS } from '../menu/api'
import { allMenuTreeQuery, collectMenuIds, roleMenusQuery, useUpdateRoleMenus, type MenuNode, type Role } from './api'
import {
  expandableIds, filterPermTree, fixOrphans, indexMenus, orphanIds, rowsWithMatchingButtons,
  sameSet, stateOf, stateOfAll, toggleNode, toPermTree,
  type MenuIndex, type PermNode, type TriState,
} from './perm-tree'

/**
 * 功能权限矩阵。
 *
 * 取代原先那个「抽屉 + 树形多选」：按钮权限不再是树里的叶子行，
 * 而是收在所属菜单行右边的「已授权 n/m」里，点开就地展开成一格一格的复选框，
 * 每个按钮下面直接标权限码 —— 行保持紧凑，23 个按钮的菜单也不会把行撑爆。
 *
 * 草稿是 `draft ?? baseline` 两层：后台 refetch 回来的新数据不会冲掉手上没存的改动，
 * 保存成功后把 draft 清成 null，界面重新跟随服务端。
 */
export function PermMatrix({
  role,
  onDirtyChange,
}: {
  role: Role
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const editable = can('sys:role:menu:edit')

  const { data: allMenus = [], isPending: loadingAll } = useQuery(allMenuTreeQuery)
  const { data: owned, isPending: loadingOwned, isFetching } = useQuery(roleMenusQuery(role.id))

  const idx = React.useMemo<MenuIndex>(() => indexMenus(allMenus), [allMenus])
  const tree = React.useMemo(() => toPermTree(allMenus), [allMenus])
  const baseline = React.useMemo(() => new Set(collectMenuIds(owned)), [owned])

  const [draft, setDraft] = React.useState<Set<string> | null>(null)
  const checked = draft ?? baseline
  const dirty = draft !== null && !sameSet(draft, baseline)

  const [linked, setLinked] = React.useState(true)
  const [keyword, setKeyword] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  /**
   * 手风琴：同一时刻只摊开一行的按钮面板，和树的折叠是两件事。
   *
   * 搜索命中的行（`autoOpen`）不受这条约束 —— 搜出来的本来就是一小撮，
   * 只留一行开着等于把其它命中结果又藏回去了。
   */
  const [openPerm, setOpenPerm] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const save = useUpdateRoleMenus()

  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  /**
   * 菜单标题的翻译：key 用 **path**（库里的 title 管理员随时能改），
   * 回落到「标题本身即 key」——按钮没有 path，走的就是这一级。
   * 搜索也要用它，否则英文界面下搜屏幕上显示的那串字搜不到。
   */
  const menuTitle = React.useCallback(
    (title: string, path?: string | null) =>
      path ? t(menuKey(path), { defaultValue: t(title) }) : t(title),
    [t]
  )

  const shown = React.useMemo(() => filterPermTree(tree, keyword, menuTitle), [tree, keyword, menuTitle])
  // 搜到的是按钮就自动把那行摊开，不然「搜到了但看不见」
  const autoOpen = React.useMemo(
    () => new Set(rowsWithMatchingButtons(tree, keyword, menuTitle)),
    [tree, keyword, menuTitle]
  )
  const orphans = React.useMemo(() => orphanIds(checked, idx), [checked, idx])
  const rootState = stateOfAll(idx.allIds, checked)

  const apply = (next: Set<string>) => {
    setError(null)
    setDraft(next)
  }

  const toggle = (id: string) => apply(toggleNode(id, checked, idx, linked))
  const toggleAll = () => apply(rootState === 'checked' ? new Set() : new Set(idx.allIds))

  const allExpandable = React.useMemo(() => expandableIds(tree), [tree])
  const allCollapsed = collapsed.size >= allExpandable.length && allExpandable.length > 0

  const loading = loadingAll || loadingOwned

  async function handleSave() {
    setError(null)
    try {
      await save.mutateAsync({ id: role.id, menus: [...checked] })
      setDraft(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  return (
    <div className="flex flex-col gap-3 content-scroll:lg:min-h-0 content-scroll:lg:flex-1" data-testid="perm-matrix">
      {/*
        工具条要一直在手边。两种模式两条路：
        - 整块在滚（整页滚动模式 / 窄屏）→ `sticky top-0`，靠 bg + -mx-1/px-1 盖住滚过去的行
        - 定高视区（内容区滚动 + 宽屏）→ 它本来就在滚动区**外面**，改回 static，
          否则 sticky 元素在不滚动的容器里只是白占一个层叠上下文
      */}
      <div className="sticky top-0 z-20 -mx-1 flex shrink-0 flex-wrap items-center gap-2 bg-background px-1 py-2 content-scroll:lg:static">
        <WhenEditable editable={editable}>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={handleSave} data-testid="perm-save">
            {save.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconDeviceFloppy className="size-4" />}
            {t('保存权限')}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8"
            disabled={!dirty || save.isPending}
            onClick={() => { setDraft(null); setError(null) }}
            data-testid="perm-reset"
          >
            <IconRotate className="size-4" />{t('还原')}
          </Button>
        </WhenEditable>

        <span className="text-sm text-muted-foreground" data-testid="perm-count">
          {t('已选 {{n}} / {{total}}', { n: checked.size, total: idx.allIds.length })}
        </span>
        {dirty && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300"
                data-testid="perm-dirty">
            {t('未保存')}
          </span>
        )}
        {keyword && autoOpen.size > 0 && (
          <span className="text-xs text-muted-foreground" data-testid="perm-search-note">
            {t('命中的 {{n}} 行已摊开', { n: autoOpen.size })}
          </span>
        )}
        {orphans.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => editable && apply(fixOrphans(checked, idx))}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300"
                />
              }
              data-testid="perm-orphans"
            >
              <IconAlertTriangle className="size-3" />{t('{{n}} 个挂不上', { n: orphans.length })}
            </TooltipTrigger>
            <TooltipContent>
              {t('这些节点的上级目录没勾，侧边栏里不会出现。点一下自动补齐上级。')}
            </TooltipContent>
          </Tooltip>
        )}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <InputGroup className="h-8 w-52">
            <InputGroupAddon align="inline-start">
              <IconSearch className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              value={keyword}
              data-testid="perm-search"
              placeholder={t("搜索菜单 / 权限码…")}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </InputGroup>

          {/* 节点关联 = 父子级联；节点独立 = 只动自己（配「有按钮权限但不给菜单入口」） */}
          <ToggleGroup
            value={[linked ? 'linked' : 'free']}
            onValueChange={(v) => { if (v.length) setLinked(v[0] === 'linked') }}
            variant="outline" size="sm" spacing={0}
          >
            <ToggleGroupItem value="linked" className="h-8 text-xs" data-testid="perm-linked">{t('节点关联')}</ToggleGroupItem>
            <ToggleGroupItem value="free" className="h-8 text-xs" data-testid="perm-free">{t('节点独立')}</ToggleGroupItem>
          </ToggleGroup>

          <Button
            variant="outline" size="sm" className="h-8"
            data-testid="perm-fold"
            onClick={() => {
              setCollapsed(allCollapsed ? new Set() : new Set(allExpandable))
              if (!allCollapsed) setOpenPerm(null)
            }}
          >
            {allCollapsed ? <IconFoldDown className="size-4" /> : <IconFoldUp className="size-4" />}
            {allCollapsed ? t('展开全部') : t('折叠全部')}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive" data-testid="perm-error">{error}</p>}

      <div
        className={cn(
          'overflow-x-auto rounded-lg border transition-opacity',
          // 定高视区：真正滚的是 Table 内部的 table-container（见 ui/components/table.tsx）
          'content-scroll:lg:flex content-scroll:lg:min-h-0 content-scroll:lg:flex-1 content-scroll:lg:flex-col',
          isFetching && !loading && 'opacity-60'
        )}
        data-testid="perm-table"
        aria-busy={isFetching}
      >
        <Table>
          {/* 吸顶表头：`bg-muted` 不能省（透明的话滚上来的行会透出来），
              inset 阴影补分隔线 —— collapse 表格里 thead 的 border 会跟着滚走 */}
          <TableHeader className="sticky top-0 z-10 bg-muted shadow-[inset_0_-1px_0_var(--border)]">
            <TableRow>
              <TableHead className="min-w-64">
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={rootState === 'checked'}
                    indeterminate={rootState === 'indeterminate'}
                    disabled={!editable || loading}
                    onCheckedChange={toggleAll}
                    data-testid="perm-check-all"
                    aria-label={t("全选所有菜单与按钮")}
                  />
                  {t('菜单 / 目录')}
                </span>
              </TableHead>
              <TableHead className="w-24">{t('类型')}</TableHead>
              <TableHead className="w-40 text-end">{t('按钮权限')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <DataTableSkeletonRows rows={8} columns={3} />
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  {keyword ? t('没有匹配的菜单或权限码') : t('还没有配置任何菜单')}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((n) => (
                <PermRows
                  key={n.id} node={n} depth={0}
                  menuTitle={menuTitle}
                  checked={checked} idx={idx} editable={editable}
                  collapsed={collapsed}
                  openPerm={openPerm}
                  autoOpen={autoOpen}
                  onTogglePerms={(id) => setOpenPerm((cur) => (cur === id ? null : id))}
                  onToggleCollapse={(id) =>
                    setCollapsed((p) => {
                      const s = new Set(p)
                      if (s.has(id)) s.delete(id)
                      else s.add(id)
                      return s
                    })
                  }
                  onToggle={toggle}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/** 无权改授权时把保存/还原整块摘掉，而不是留一排灰按钮 */
function WhenEditable({ editable, children }: { editable: boolean; children: React.ReactNode }) {
  return editable ? <>{children}</> : null
}

function PermRows({
  node, depth, menuTitle, checked, idx, editable, collapsed, openPerm, autoOpen,
  onToggleCollapse, onTogglePerms, onToggle,
}: {
  node: PermNode
  depth: number
  menuTitle: (title: string, path?: string | null) => string
  checked: ReadonlySet<string>
  idx: MenuIndex
  editable: boolean
  collapsed: Set<string>
  openPerm: string | null
  autoOpen: Set<string>
  onToggleCollapse: (id: string) => void
  onTogglePerms: (id: string) => void
  onToggle: (id: string) => void
}) {
  const { t } = useTranslation()
  const hasKids = node.children.length > 0
  const open = !collapsed.has(node.id)
  const state = stateOf(node.id, checked, idx)
  const isDir = node.type === 0

  const granted = node.buttons.reduce((n, b) => (checked.has(b.id) ? n + 1 : n), 0)
  const permsOpen = openPerm === node.id || autoOpen.has(node.id)

  return (
    <>
      <TableRow data-testid={`perm-row-${node.id}`} className={cn(isDir && 'bg-muted/30')}>
        <TableCell className="py-2">
          <span className="flex items-center gap-1.5" style={{ paddingInlineStart: `${depth * 20}px` }}>
            {hasKids ? (
              <button
                type="button"
                aria-label={open ? t('折叠') : t('展开')}
                onClick={() => onToggleCollapse(node.id)}
                data-testid={`perm-toggle-${node.id}`}
                className="grid size-4 shrink-0 place-content-center rounded-sm hover:bg-muted"
              >
                <IconChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <PermCheck
              id={node.id} label={menuTitle(node.title, node.path)} state={state} editable={editable}
              onToggle={onToggle}
              icon={<MenuIcon name={node.icon} />}
              labelClassName={isDir ? 'font-medium' : ''}
            />
          </span>
        </TableCell>

        <TableCell className="py-2">
          <Badge variant={isDir ? 'secondary' : 'outline'} className="font-normal">
            {t(MENU_TYPE_ITEMS[String(node.type)] ?? String(node.type))}
          </Badge>
        </TableCell>

        <TableCell className="py-2 text-end">
          {node.buttons.length === 0 ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <button
              type="button"
              onClick={() => onTogglePerms(node.id)}
              aria-expanded={permsOpen}
              data-testid={`perm-buttons-${node.id}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
                granted > 0
                  ? 'border-primary/30 bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted'
              )}
            >
              {t('已授权 {{n}}/{{total}}', { n: granted, total: node.buttons.length })}
              <IconChevronDown className={cn('size-3.5 transition-transform', permsOpen && 'rotate-180')} />
            </button>
          )}
        </TableCell>
      </TableRow>

      {/* 按钮面板：就地展开，不是下钻。权限码常驻显示 —— 配权限的人真正认的是这串码 */}
      {permsOpen && node.buttons.length > 0 && (
        <TableRow className="hover:bg-transparent" data-testid={`perm-panel-${node.id}`}>
          <TableCell colSpan={3} className="bg-muted/20 py-3">
            <div
              className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
              style={{ paddingInlineStart: `${depth * 20 + 24}px` }}
            >
              {node.buttons.map((b) => (
                <ButtonPerm
                  key={b.id} btn={b} label={menuTitle(b.title)}
                  checked={checked.has(b.id)} editable={editable} onToggle={onToggle}
                />
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}

      {hasKids && open &&
        node.children.map((c) => (
          <PermRows
            key={c.id} node={c} depth={depth + 1}
            menuTitle={menuTitle}
            checked={checked} idx={idx} editable={editable}
            collapsed={collapsed} openPerm={openPerm} autoOpen={autoOpen}
            onToggleCollapse={onToggleCollapse} onTogglePerms={onTogglePerms} onToggle={onToggle}
          />
        ))}
    </>
  )
}

function ButtonPerm({
  btn, label, checked, editable, onToggle,
}: {
  btn: MenuNode
  /** 已翻译的按钮标题（种子数据里的中文即 key） */
  label: string
  checked: boolean
  editable: boolean
  onToggle: (id: string) => void
}) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <Checkbox
        checked={checked}
        disabled={!editable}
        onCheckedChange={() => onToggle(btn.id)}
        data-testid={`perm-check-${btn.id}`}
        aria-label={label}
        className="mt-0.5"
      />
      <span
        className={cn('flex min-w-0 flex-col select-none', editable && 'cursor-pointer')}
        onClick={() => editable && onToggle(btn.id)}
      >
        <span className="truncate text-sm">{label}</span>
        {btn.perms && (
          <code className="truncate text-[11px] text-muted-foreground" title={btn.perms}>{btn.perms}</code>
        )}
      </span>
    </span>
  )
}

/**
 * 复选框 + 可点的文字。
 *
 * 文字**不能**包成 `<label htmlFor>`：Base UI 的 Checkbox 根节点渲染成
 * `<span role="checkbox">`（实测过），span 不是 labelable element，
 * `<label for>` 点了不会转发。所以直接给文字挂 onClick，
 * 和复选框各管各的点击区，不会双触发。
 */
function PermCheck({
  id, label, state, editable, onToggle, icon, labelClassName,
}: {
  id: string
  label: string
  state: TriState
  editable: boolean
  onToggle: (id: string) => void
  icon?: React.ReactNode
  labelClassName?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Checkbox
        checked={state === 'checked'}
        indeterminate={state === 'indeterminate'}
        disabled={!editable}
        onCheckedChange={() => onToggle(id)}
        data-testid={`perm-check-${id}`}
        aria-label={label}
      />
      {icon}
      <span
        onClick={() => editable && onToggle(id)}
        className={cn('text-sm select-none', editable && 'cursor-pointer', labelClassName)}
      >
        {label}
      </span>
    </span>
  )
}
