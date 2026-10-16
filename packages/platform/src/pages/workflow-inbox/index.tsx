import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronDown, IconPlus } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Pagination } from '@admin/ui/components/pagination'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { cn } from '@admin/ui/lib/utils'
import { formatDateTime } from '@admin/i18n'

import { PageHeader } from '../../shell/page-header'
import { useSocketEvent } from '../../shell/socket-events'
import { RefreshButton, TextFilter } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import {
  countsQuery, inboxQuery, startableQuery, workflowKeys,
  type Definition, type InboxTab, type InstanceRow,
} from '../workflow/api'
import { InstanceSheet } from '../workflow/instance-sheet'
import { StartSheet } from '../workflow/start-sheet'
import { InstanceStatusPill } from '../workflow/status'

export type WorkflowInboxSearch = {
  tab?: InboxTab
  page?: number
  size?: number
  keyword?: string
  /** 打开着的审批单（详情抽屉） */
  id?: string
  /** 正在发起的流程编码（发起抽屉） */
  start?: string
}

const TABS: { value: InboxTab; label: string }[] = [
  { value: 'todo', label: '待我审批' },
  { value: 'done', label: '我已审批' },
  { value: 'initiated', label: '我发起的' },
  { value: 'cc', label: '抄送我的' },
]

/**
 * 审批中心（#107 阶段 2）：待我审批 / 我已审批 / 我发起的 / 抄送我的 + 发起入口。
 *
 * 🔴 只要登录就能进（路由守卫 `requireAuth`），不挂权限码 —— avc-bp 踩过：审批中心
 * 挂了权限码，普通员工进不去。
 *
 * 详情和发起都是抽屉，**开着哪个写在 URL 里**（`?id=` / `?start=`，硬纪律 2）：
 * 消息中心里的审批通知直接链到 `/workflow/inbox?id=…`，刷新也还开着。
 */
export function WorkflowInboxPage({
  search = {},
  onSearchChange,
}: {
  search?: WorkflowInboxSearch
  onSearchChange?: (next: WorkflowInboxSearch) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const tab = search.tab ?? 'todo'
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = (p: Partial<WorkflowInboxSearch>) => onSearchChange?.({ ...search, ...p })

  const listQuery = useQuery(inboxQuery({ tab, page, size, keyword: search.keyword }))
  const list = listState(listQuery)
  const counts = useQuery(countsQuery()).data

  // 待办变了（新来 / 被别人办掉 / 实例结束）：服务端只推一个空事件，这里重取
  useSocketEvent('workflow:todo', () => {
    qc.invalidateQueries({ queryKey: workflowKeys.counts() })
    qc.invalidateQueries({ queryKey: workflowKeys.inbox() })
  })

  const rows = listQuery.data?.items ?? []
  const badge = (v: InboxTab) => (v === 'todo' ? counts?.todo : v === 'cc' ? counts?.cc_unread : undefined)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('审批中心')}>
        <StartMenu onPick={(code) => patch({ start: code })} />
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(v) => patch({ tab: v as InboxTab, page: 1, keyword: undefined })}>
          <TabsList>
            {TABS.map((x) => (
              <TabsTrigger key={x.value} value={x.value} data-testid={`wf-inbox-tab-${x.value}`}>
                {t(x.label)}
                {!!badge(x.value) && (
                  <Badge variant="secondary" className="ms-1 h-4 min-w-4 px-1 text-[10px]" data-testid={`wf-badge-${x.value}`}>
                    {badge(x.value)}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <TextFilter
            value={search.keyword ?? ''}
            placeholder="搜索标题或摘要"
            onCommit={(v) => patch({ keyword: v.trim() || undefined, page: 1 })}
            testId="wf-inbox-search"
          />
          <RefreshButton onClick={list.onRetry} busy={list.busy} />
        </div>
      </div>

      <div className={cn('flex flex-col overflow-hidden rounded-lg border', list.busy && 'opacity-60')} data-testid="wf-inbox-list">
        {list.loading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="m-3 h-12" />)
        ) : list.error ? (
          <QueryError error={list.error} onRetry={list.onRetry} className="m-4" />
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground" data-testid="wf-inbox-empty">
            {tab === 'todo' ? t('没有待你审批的单据') : t('暂无数据')}
          </p>
        ) : (
          rows.map((r) => <InboxRow key={`${r.id}:${r.task_id ?? r.cc_id ?? ''}`} row={r} tab={tab} onOpen={() => patch({ id: r.id })} />)
        )}
      </div>

      {(listQuery.data?.total ?? 0) > 0 && (
        <Pagination
          pageIndex={page - 1}
          pageCount={Math.max(1, listQuery.data?.total_pages ?? 1)}
          pageSize={size}
          totalCount={listQuery.data?.total ?? 0}
          onPageChange={(i) => patch({ page: i + 1 })}
          onPageSizeChange={(s) => patch({ size: s, page: 1 })}
        />
      )}

      <InstanceSheet id={search.id ?? null} onClose={() => patch({ id: undefined })} />
      <StartSheet
        code={search.start ?? null}
        onClose={() => patch({ start: undefined })}
        onStarted={(id) => patch({ start: undefined, tab: 'initiated', page: 1, id })}
      />
    </div>
  )
}

function InboxRow({ row: r, tab, onOpen }: { row: InstanceRow; tab: InboxTab; onOpen: () => void }) {
  const { t } = useTranslation()
  const unread = tab === 'cc' && !r.read_time
  const time = tab === 'todo' ? r.arrived_time : tab === 'done' ? r.handled_time : tab === 'cc' ? r.cc_time : r.created_time
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 border-b px-4 py-3 text-start last:border-b-0 hover:bg-muted/50"
      data-testid={`wf-row-${r.id}`}
    >
      <span className={cn('mt-2 size-2 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{r.title}</span>
          {tab === 'todo' ? (
            <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">{r.node_name}</span>
          ) : (
            <InstanceStatusPill status={r.status} />
          )}
        </span>
        {r.summary && <span className="truncate text-sm text-muted-foreground">{r.summary}</span>}
        <span className="text-xs text-muted-foreground">
          {r.definition_name} · {t('发起人')} {r.initiator_name ?? '—'}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(time ?? null)}</span>
    </button>
  )
}

/** 「发起审批」：已发布的表单审批，按分组列出 */
function StartMenu({ onPick }: { onPick: (code: string) => void }) {
  const { t } = useTranslation()
  const { data, error, isPending } = useQuery(startableQuery())
  const groups = React.useMemo(() => {
    const m = new Map<string, Definition[]>()
    for (const d of data ?? []) {
      const k = d.category || t('其他')
      m.set(k, [...(m.get(k) ?? []), d])
    }
    return [...m.entries()]
  }, [data, t])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" data-testid="wf-start-menu" />}>
        <IconPlus className="size-4" />
        {t('发起审批')}
        <IconChevronDown className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {isPending ? (
          <DropdownMenuLabel>{t('加载中…')}</DropdownMenuLabel>
        ) : error ? (
          <DropdownMenuLabel className="text-destructive">{t('加载失败，请重试')}</DropdownMenuLabel>
        ) : groups.length === 0 ? (
          <DropdownMenuLabel className="text-muted-foreground">{t('还没有可发起的审批')}</DropdownMenuLabel>
        ) : (
          groups.map(([g, defs], i) => (
            <React.Fragment key={g}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{g}</DropdownMenuLabel>
                {defs.map((d) => (
                  <DropdownMenuItem key={d.id} onClick={() => onPick(d.code)} data-testid={`wf-start-${d.code}`}>
                    {d.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </React.Fragment>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('待我审批'), t('我已审批'), t('我发起的'), t('抄送我的')]
}
