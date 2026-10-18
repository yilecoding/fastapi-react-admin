import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconChecklist, IconCircleCheck, IconCopy, IconInbox, IconPlus, IconSearch, IconSend,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@admin/ui/components/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@admin/ui/components/input-group'
import { Pagination } from '@admin/ui/components/pagination'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'
import { formatDateTimeShort } from '@admin/i18n'

import { PageHeader } from '../../shell/page-header'
import { useSocketEvent } from '../../shell/socket-events'
import { RefreshButton, TextFilter } from '../_shared/filters'
import { listState } from '../_shared/list-query'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import {
  countsQuery, draftsQuery, inboxQuery, startableQuery, workflowKeys,
  type Definition, type InboxTab, type InstanceRow,
} from '../workflow/api'
import { InstanceSheet } from '../workflow/instance-sheet'
import { StartSheet } from '../workflow/start-sheet'
import { InstanceStatusPill } from '../workflow/status'
import { PersonAvatar, TemplateTile, UrgentTag } from '../workflow/track'

export type WorkflowInboxSearch = {
  tab?: InboxTab
  page?: number
  size?: number
  keyword?: string
  /** 打开着的审批单（详情抽屉） */
  id?: string
  /** 正在发起的流程编码（发起抽屉） */
  start?: string
  /** 重新发起：从这张单复制内容 */
  from?: string
}

const TABS: { value: InboxTab; label: string; icon: React.ComponentType<{ className?: string }>; empty: string }[] = [
  { value: 'todo', label: '待我审批', icon: IconInbox, empty: '没有等你处理的审批' },
  { value: 'done', label: '我已审批', icon: IconCircleCheck, empty: '你还没有处理过审批' },
  { value: 'initiated', label: '我发起的', icon: IconSend, empty: '你还没有发起过审批' },
  { value: 'cc', label: '抄送我的', icon: IconCopy, empty: '还没有抄送给你的审批' },
]

/**
 * 审批中心（#107 阶段 2）。
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
  const [picking, setPicking] = React.useState(false)

  const listQuery = useQuery(inboxQuery({ tab, page, size, keyword: search.keyword }))
  const list = listState(listQuery)
  const counts = useQuery(countsQuery()).data

  // 待办变了（新来 / 被别人办掉 / 实例结束）：服务端只推一个空事件，这里重取
  useSocketEvent('workflow:todo', () => {
    qc.invalidateQueries({ queryKey: workflowKeys.counts() })
    qc.invalidateQueries({ queryKey: workflowKeys.inbox() })
  })

  const rows = listQuery.data?.items ?? []
  const current = TABS.find((x) => x.value === tab) ?? TABS[0]
  const badge = (v: InboxTab) => (v === 'todo' ? counts?.todo : v === 'cc' ? counts?.cc_unread : undefined)

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 lg:flex-row lg:items-start">
      <PageHeader title={t('审批中心')} />

      <nav className="flex shrink-0 flex-col gap-3 lg:sticky lg:top-4 lg:w-52" aria-label={t('审批中心')}>
        <Button size="lg" className="justify-start gap-2" onClick={() => setPicking(true)} data-testid="wf-start-menu">
          <IconPlus className="size-4" />
          {t('发起申请')}
        </Button>
        <ul className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1">
          {TABS.map((x) => {
            const n = badge(x.value)
            const on = x.value === tab
            return (
              <li key={x.value}>
                <button
                  type="button"
                  onClick={() => patch({ tab: x.value, page: 1, keyword: undefined })}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors',
                    on ? 'bg-primary/15 font-medium text-foreground [&>svg]:text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                  aria-current={on ? 'page' : undefined}
                  data-testid={`wf-inbox-tab-${x.value}`}
                >
                  <x.icon className="size-4 shrink-0" />
                  <span className="flex-1 text-start">{t(x.label)}</span>
                  {!!n && (
                    <span
                      className={cn(
                        'min-w-5 rounded-full px-1.5 text-center text-xs leading-5 tabular-nums',
                        x.value === 'todo' ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground'
                      )}
                      data-testid={`wf-badge-${x.value}`}
                    >
                      {n > 99 ? '99+' : n}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{t(current.label)}</h2>
          {listQuery.data && <span className="text-sm text-muted-foreground tabular-nums">{listQuery.data.total}</span>}
          <span className="ms-auto flex items-center gap-2">
            <TextFilter
              value={search.keyword ?? ''}
              placeholder="搜索标题或摘要"
              onCommit={(v) => patch({ keyword: v.trim() || undefined, page: 1 })}
              testId="wf-inbox-search"
            />
            <RefreshButton onClick={list.onRetry} busy={list.busy} />
          </span>
        </div>

        <div
          className={cn('overflow-hidden rounded-xl border bg-card', list.busy && 'opacity-60')}
          data-testid="wf-inbox-list"
        >
          {list.loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))
          ) : list.error ? (
            <QueryError error={list.error} onRetry={list.onRetry} className="m-4" />
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center" data-testid="wf-inbox-empty">
              <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <IconChecklist className="size-6" />
              </span>
              <p className="text-sm text-muted-foreground">
                {search.keyword ? t('没有匹配「{{k}}」的审批', { k: search.keyword }) : t(current.empty)}
              </p>
              {tab === 'initiated' && !search.keyword && (
                <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                  {t('发起申请')}
                </Button>
              )}
            </div>
          ) : (
            rows.map((r) => (
              <InboxRow key={`${r.id}:${r.task_id ?? r.cc_id ?? ''}`} row={r} tab={tab} onOpen={() => patch({ id: r.id })} />
            ))
          )}
        </div>

        {(listQuery.data?.total ?? 0) > size && (
          <Pagination
            pageIndex={page - 1}
            pageCount={Math.max(1, listQuery.data?.total_pages ?? 1)}
            pageSize={size}
            totalCount={listQuery.data?.total ?? 0}
            onPageChange={(i) => patch({ page: i + 1 })}
            onPageSizeChange={(s) => patch({ size: s, page: 1 })}
          />
        )}
      </section>

      <TemplatePicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(code) => {
          setPicking(false)
          patch({ start: code })
        }}
      />
      <InstanceSheet
        id={search.id ?? null}
        onClose={() => patch({ id: undefined })}
        onResubmit={(code, fromId) => patch({ id: undefined, start: code, from: fromId })}
      />
      <StartSheet
        code={search.start ?? null}
        fromId={search.from ?? null}
        onClose={() => patch({ start: undefined, from: undefined })}
        onStarted={(id) => patch({ start: undefined, from: undefined, tab: 'initiated', page: 1, id })}
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
      className="group flex w-full items-start gap-3 border-b px-4 py-3.5 text-start transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      data-testid={`wf-row-${r.id}`}
    >
      <span className="relative">
        <PersonAvatar name={r.initiator_name ?? ''} size="md" />
        {unread && <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className={cn('truncate', unread ? 'font-semibold' : 'font-medium')}>{r.title}</span>
          {r.urgent && <UrgentTag />}
          {tab === 'todo' ? (
            <span className="shrink-0 rounded bg-amber-500/10 px-1.5 text-xs leading-5 text-amber-700 dark:text-amber-400">
              {t('待 {{node}}', { node: r.node_name })}
            </span>
          ) : (
            <InstanceStatusPill status={r.status} />
          )}
        </span>
        {r.summary && <span className="line-clamp-1 text-sm text-muted-foreground">{r.summary}</span>}
        <span className="text-xs text-muted-foreground">
          {r.definition_name}
          {tab === 'done' && r.node_name ? ` · ${r.node_name}` : ''}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTimeShort(time ?? null)}</span>
    </button>
  )
}

/** 「发起申请」：已发布的表单审批，按分组排成磁贴，可搜 */
function TemplatePicker({
  open, onOpenChange, onPick,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (code: string) => void
}) {
  const { t } = useTranslation()
  const query = useQuery({ ...startableQuery(), enabled: open })
  // 有没提交的草稿的，磁贴上标一下：用户知道点进去内容还在
  const drafts = useQuery({ ...draftsQuery(), enabled: open })
  const hasDraft = React.useMemo(() => new Set((drafts.data ?? []).map((x) => x.code)), [drafts.data])
  const [keyword, setKeyword] = React.useState('')
  React.useEffect(() => {
    if (open) setKeyword('')
  }, [open])
  const groups = React.useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const m = new Map<string, Definition[]>()
    for (const d of query.data ?? []) {
      if (kw && !`${d.name} ${d.description ?? ''} ${d.category ?? ''}`.toLowerCase().includes(kw)) continue
      const k = d.category || t('其他')
      m.set(k, [...(m.get(k) ?? []), d])
    }
    return [...m.entries()]
  }, [query.data, keyword, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="wf-template-picker">
        <DialogHeader>
          <DialogTitle>{t('发起申请')}</DialogTitle>
          <DialogDescription>{t('选一个审批类型，填写后提交')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          <InputGroup className="h-9">
            <InputGroupAddon align="inline-start">
              <IconSearch className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={keyword}
              placeholder={t('搜索审批类型')}
              onChange={(e) => setKeyword(e.target.value)}
              data-testid="wf-template-search"
            />
          </InputGroup>
          <div className="flex max-h-[60svh] flex-col gap-5 overflow-y-auto">
            {query.isPending ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
              </div>
            ) : query.error ? (
              <QueryError error={query.error} onRetry={() => query.refetch()} />
            ) : groups.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {keyword ? t('没有匹配的审批类型') : t('还没有可发起的审批，请联系管理员在「流程定义」里发布')}
              </p>
            ) : (
              groups.map(([g, defs]) => (
                <section key={g} className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">{g}</h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                    {defs.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => onPick(d.code)}
                        className="flex items-center gap-3 rounded-lg border bg-card p-3 text-start transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:border-primary focus-visible:outline-none"
                        data-testid={`wf-start-${d.code}`}
                      >
                        <TemplateTile name={d.name} group={d.category} />
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{d.name}</span>
                            {hasDraft.has(d.code) && (
                              <span className="shrink-0 rounded bg-muted px-1 text-[11px] leading-4 text-muted-foreground" data-testid={`wf-has-draft-${d.code}`}>
                                {t('草稿')}
                              </span>
                            )}
                          </span>
                          {d.description && <span className="truncate text-xs text-muted-foreground">{d.description}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [
    t('待我审批'), t('我已审批'), t('我发起的'), t('抄送我的'),
    t('没有等你处理的审批'), t('你还没有处理过审批'), t('你还没有发起过审批'), t('还没有抄送给你的审批'),
  ]
}
