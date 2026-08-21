import { useTranslation } from 'react-i18next'
import {
  IconChevronLeft, IconChevronRight, IconDotsVertical, IconPencil, IconPlus, IconRefresh, IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ResetButton, StatusFilter, TextFilter } from '../_shared/filters'
import { TONE_CLASS } from '../_shared/status'
import type { Role } from './api'

/**
 * 左栏角色列表 —— 是个**选择器**，不是数据表格。
 *
 * 详细字段（备注/创建时间/数据权限开关）都挪到右栏的详情头里了：
 * 这一栏只要够快地在角色之间跳，所以一行只放名称 + 状态点。
 */
export function RoleList({
  roles, total, page, size, loading, busy, selectedId, keyword, status,
  onKeyword, onStatus, onReset, onPage, onSelect, onAdd, onEdit, onDelete, onRefresh,
}: {
  roles: Role[]
  total: number
  page: number
  size: number
  loading: boolean
  busy: boolean
  selectedId: string | null
  keyword: string
  status: number | undefined
  onKeyword: (v: string) => void
  onStatus: (v: number | undefined) => void
  onReset: () => void
  onPage: (p: number) => void
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (r: Role) => void
  onDelete: (r: Role) => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const totalPages = Math.max(1, Math.ceil(total / size))
  const hasFilter = Boolean(keyword || status !== undefined)

  return (
    // 三种情形三套行为：
    //   lg 以下          整宽的一栏（两栏是上下堆叠的）
    //   lg+ 内容区滚动    定高的一栏，min-h-0 让它能被约束住，列表区自己滚
    //   lg+ 整页滚动      整块跟着页面滚，所以要吸顶（配 self-start —— 被拉伸到
    //                    整行高度的元素是「粘」不起来的，它本来就够高）
    <div
      className="flex w-full shrink-0 flex-col gap-3 lg:w-72 content-scroll:lg:min-h-0 page-scroll:lg:sticky page-scroll:lg:top-4 page-scroll:lg:self-start"
      data-testid="role-list"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">{t('角色列表')}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label={t("刷新")} onClick={onRefresh}
                  data-testid="role-refresh">
            <IconRefresh className={cn('size-4', busy && 'animate-spin')} />
          </Button>
          <Can perm="sys:role:add">
            <Button variant="ghost" size="icon" className="size-7" aria-label={t("新增角色")} onClick={onAdd}
                    data-testid="add-role">
              <IconPlus className="size-4" />
            </Button>
          </Can>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <TextFilter
          value={keyword}
          placeholder={t("搜索角色名称…")}
          testId="filter-name"
          width="w-full"
          onCommit={onKeyword}
        />
        <div className="flex items-center gap-2">
          <StatusFilter value={status} onChange={onStatus} />
          {hasFilter && <ResetButton onClick={onReset} />}
        </div>
      </div>

      {/*
        视口算式是**兜底**（整页滚动模式 / 窄屏堆叠时父级高度是 auto，只能这么算）。
        定高的那种情形下改成 flex-1 撑满，max-h 要显式取消 —— 否则 480px 的
        硬上限会让列表在 900px 高的栏里只用一半，下面空一大片还照旧内滚。
      */}
      <div
        className="flex max-h-[calc(100svh-20rem)] flex-col gap-1 overflow-y-auto content-scroll:lg:max-h-none content-scroll:lg:min-h-0 content-scroll:lg:flex-1"
        data-testid="role-items"
      >
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)
        ) : roles.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">{t('没有匹配的角色')}</p>
        ) : (
          roles.map((r) => (
            <RoleItem
              key={r.id} role={r} active={r.id === selectedId}
              onSelect={() => onSelect(r.id)} onEdit={() => onEdit(r)} onDelete={() => onDelete(r)}
            />
          ))
        )}
      </div>

      {/* page/size 在 search schema 里，就必须给得出第 2 页的入口 */}
      <div className="mt-auto flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
        <span data-testid="role-total">{t('共 {{n}} 条', { n: total })}</span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" aria-label={t("上一页")}
                  disabled={page <= 1} onClick={() => onPage(page - 1)} data-testid="role-prev">
            <IconChevronLeft className="size-3.5" />
          </Button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="size-6" aria-label={t("下一页")}
                  disabled={page >= totalPages} onClick={() => onPage(page + 1)} data-testid="role-next">
            <IconChevronRight className="size-3.5" />
          </Button>
        </span>
      </div>
    </div>
  )
}

function RoleItem({
  role, active, onSelect, onEdit, onDelete,
}: {
  role: Role
  active: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
        active ? 'bg-accent' : 'hover:bg-muted/60'
      )}
      data-testid={`role-item-${role.id}`}
      data-active={active}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-start"
      >
        <span
          className={cn('size-1.5 shrink-0 rounded-full', role.status === 1 ? 'bg-emerald-500' : 'bg-destructive')}
          aria-label={t(role.status === 1 ? '正常' : '停用')}
        />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', active && 'font-medium')}>{role.name}</span>
          {/* 编码常驻显示而不是塞进 tooltip —— 它是「在配置里怎么写这个角色」的答案，
              要能直接读出来抄走 */}
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <code className="shrink-0 font-mono">{role.code}</code>
            {role.remark && <span className="truncate">· {role.remark}</span>}
          </span>
        </span>
        {!role.is_filter_scopes && (
          <span className={cn('shrink-0 rounded px-1 text-[10px] ring-1', TONE_CLASS.info)} title={t("不受数据范围限制")}>
            {t('全量')}
          </span>
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost" size="icon"
              className={cn('size-6 shrink-0 opacity-0 group-hover:opacity-100', active && 'opacity-100')}
              aria-label={t('操作 {{name}}', { name: role.name })}
            />
          }
          data-testid={`role-actions-${role.id}`}
        >
          <IconDotsVertical className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-32">
          <Can perm="sys:role:edit">
            <DropdownMenuItem onClick={onEdit} data-testid={`role-edit-${role.id}`}>
              <IconPencil className="size-4" />{t('编辑')}
            </DropdownMenuItem>
          </Can>
          <Can perm="sys:role:del">
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete} data-testid={`role-delete-${role.id}`}>
              <IconTrash className="size-4" />{t('删除')}
            </DropdownMenuItem>
          </Can>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
