import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconDotsVertical, IconPlus, IconRefresh } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { SearchWithStatus, TextFilter } from './filters'
import { useInfiniteScroll } from './use-infinite-scroll'

/**
 * 主从页左栏的**唯一实现** —— 角色管理 / 数据权限 / 数据字典共用。
 *
 * 三个页原先各写一份，于是长出三种脾气：标题行有的有有的没有、
 * 搜索框有的带状态筛选有的不带、底部有的是分页条有的是「仅加载前 200 个」、
 * 列表有的裹在边框里有的没有。同一个东西三种样子，改一处漂移一处。
 *
 * 它是**选择器**不是数据表：一行只回答「这是谁」，详细字段都在右栏。
 * 所以没有列、没有排序、没有分页条 —— 要找就搜，要看就滚。
 *
 * 数据策略由调用方决定，这里只认结果：
 * - 给 `hasMore` / `onLoadMore` → 滚到底自动取下一页（角色 / 数据范围）
 * - 不给                        → 就这些了（字典类型一次取全 + 前端过滤）
 */
export type MasterListItem = {
  id: string
  title: string
  /** 等宽编码。常驻显示而不是塞 tooltip —— 它是「在配置里怎么写」的答案，要能抄走 */
  code?: string
  /** 编码后面那句说明 */
  description?: string
  /** 状态点：1 绿 / 0 红。`undefined` 就不画点（字典类型没有这一维） */
  status?: number
  /** 行尾徽标，如角色的「全量」 */
  badge?: React.ReactNode
}

export function MasterList({
  title,
  items,
  total,
  selectedId,
  onSelect,
  keyword,
  onKeyword,
  searchPlaceholder,
  status,
  onStatus,
  onReset,
  hasMore = false,
  loadingMore = false,
  loading = false,
  busy = false,
  onLoadMore,
  onAdd,
  addLabel,
  addPerm,
  onRefresh,
  renderActions,
  emptyText,
  footerNote,
  idPrefix,
}: {
  title: string
  items: MasterListItem[]
  /** 服务端报的总数（可能大于已加载条数） */
  total: number
  selectedId: string | null
  onSelect: (id: string) => void

  keyword: string
  onKeyword: (v: string) => void
  searchPlaceholder: string
  /** 传了 status + onStatus 才渲染状态筛选（收在搜索框尾部） */
  status?: number
  onStatus?: (v: number | undefined) => void
  onReset?: () => void

  hasMore?: boolean
  loadingMore?: boolean
  loading?: boolean
  /** 后台重取中 —— 只让刷新图标转，不换骨架（换了会整栏闪一下） */
  busy?: boolean
  onLoadMore?: () => void

  onAdd?: () => void
  addLabel?: string
  /** 有权限码就用 `<Can>` 包一层 —— 没这个权限的人不该看到「+」 */
  addPerm?: string
  onRefresh?: () => void

  /** 行内 kebab 的菜单项；不传就不渲染那个按钮 */
  renderActions?: (item: MasterListItem) => React.ReactNode
  emptyText: string
  /** 底部左侧的附加说明（如「仅加载前 200 个」） */
  footerNote?: React.ReactNode
  /** data-testid 前缀：role / scope / type */
  idPrefix: string
}) {
  const { t } = useTranslation()
  // 哨兵的 root 必须是这个滚动容器，不能用视口 —— 内容区滚动模式下 window 根本不滚，
  // 而且隐藏 tab 的 DOM 也在文档树里（CLAUDE.md 硬纪律 5）
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const sentinelRef = useInfiniteScroll({
    rootRef: scrollRef,
    hasMore: hasMore && Boolean(onLoadMore),
    loading: loading || loadingMore,
    onLoadMore: onLoadMore ?? (() => {}),
  })

  const canFilterStatus = onStatus !== undefined

  return (
    // 三种情形：lg 以下整宽一栏 / lg+ 内容区滚动是定高一栏 / lg+ 整页滚动要吸顶
    // （self-start 不能省 —— 被拉伸到整行高的元素粘不住）
    <div
      className="flex w-full shrink-0 flex-col gap-3 lg:w-72 content-scroll:lg:min-h-0 page-scroll:lg:sticky page-scroll:lg:top-4 page-scroll:lg:self-start"
      data-testid={`${idPrefix}-list`}
    >
      <div className="flex shrink-0 items-center justify-between px-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-1">
          {onRefresh && (
            <Button
              variant="ghost" size="icon" className="size-7"
              aria-label={t('刷新')} onClick={onRefresh}
              data-testid={`${idPrefix}-refresh`}
            >
              <IconRefresh className={cn('size-4', busy && 'animate-spin')} />
            </Button>
          )}
          {onAdd && (
            <Can perm={addPerm}>
              <Button
                variant="ghost" size="icon" className="size-7"
                aria-label={addLabel ?? t('新增')} onClick={onAdd}
                data-testid={`add-${idPrefix}`}
              >
                <IconPlus className="size-4" />
              </Button>
            </Can>
          )}
        </div>
      </div>

      {/* 状态筛选收在搜索框尾部：这一栏只有 288px 宽，单独占一行等于
          用 40px 的高度换一个三选一，而行里本来就有状态点 */}
      {canFilterStatus ? (
        <SearchWithStatus
          value={keyword}
          placeholder={searchPlaceholder}
          status={status}
          testId="filter-name"
          onCommit={onKeyword}
          onStatus={onStatus}
          onReset={onReset && (keyword || status !== undefined) ? onReset : undefined}
        />
      ) : (
        <TextFilter
          value={keyword}
          placeholder={searchPlaceholder}
          testId="filter-name"
          width="w-full"
          onCommit={onKeyword}
        />
      )}

      <div
        ref={scrollRef}
        className="flex max-h-[calc(100svh-20rem)] flex-col gap-1 overflow-y-auto content-scroll:lg:max-h-none content-scroll:lg:min-h-0 content-scroll:lg:flex-1"
        data-testid={`${idPrefix}-items`}
      >
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)
        ) : items.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          items.map((item) => (
            <Row
              key={item.id}
              item={item}
              active={item.id === selectedId}
              idPrefix={idPrefix}
              onSelect={() => onSelect(item.id)}
              actions={renderActions?.(item)}
            />
          ))
        )}

        {/* 滚到这里就取下一页。骨架占位让「还有更多」看得见，
            而不是滚到底忽然停住让人以为就这么多 */}
        {hasMore && onLoadMore && (
          <div ref={sentinelRef} className="flex flex-col gap-1 pb-1" data-testid={`${idPrefix}-more`}>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full opacity-60" />
          </div>
        )}
      </div>

      {/* 没有分页条：选择器翻页在 288px 宽的栏里意味着
          「滚到底 → 点下一页 → 再滚回顶部找」。这里只报数。 */}
      <div className="mt-auto flex shrink-0 items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" data-testid={`${idPrefix}-total`}>
          {footerNote ?? t('共 {{n}} 条', { n: total })}
        </span>
        {hasMore && (
          <span className="shrink-0 tabular-nums" data-testid={`${idPrefix}-loaded`}>
            {t('已加载 {{n}}', { n: items.length })}
          </span>
        )}
      </div>
    </div>
  )
}

function Row({
  item, active, onSelect, actions, idPrefix,
}: {
  item: MasterListItem
  active: boolean
  onSelect: () => void
  actions?: React.ReactNode
  idPrefix: string
}) {
  const { t } = useTranslation()
  const hasSub = Boolean(item.code || item.description)
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
        active ? 'bg-accent' : 'hover:bg-muted/60'
      )}
      data-testid={`${idPrefix}-item-${item.id}`}
      data-active={active}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-start"
      >
        {item.status !== undefined && (
          <span
            className={cn('size-1.5 shrink-0 rounded-full', item.status === 1 ? 'bg-emerald-500' : 'bg-destructive')}
            aria-label={t(item.status === 1 ? '正常' : '停用')}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', active && 'font-medium')}>{item.title}</span>
          {hasSub && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {item.code && <code className="shrink-0 truncate font-mono">{item.code}</code>}
              {item.description && (
                <span className="truncate">{item.code ? `· ${item.description}` : item.description}</span>
              )}
            </span>
          )}
        </span>
        {item.badge}
      </button>

      {actions && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost" size="icon"
                className={cn('size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100', active && 'opacity-100')}
                aria-label={t('操作 {{name}}', { name: item.title })}
              />
            }
            data-testid={`${idPrefix}-actions-${item.id}`}
          >
            <IconDotsVertical className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            {actions}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
