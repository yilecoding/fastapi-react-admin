import * as React from 'react'
import { formatDateTimeShort, toEpochMs } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconArrowBackUp, IconArrowsExchange, IconCheck, IconChecklist, IconClock, IconPencil, IconUser,
} from '@tabler/icons-react'

import { Button, buttonVariants } from '@admin/ui/components/button'
import { cn } from '@admin/ui/lib/utils'

import { meQuery } from '../../../auth/queries'
import { useSocketEvent } from '../../../shell/socket-events'
import { relativeTime } from '../../notification/shared'
import { workflowKeys } from '../../workflow/api'
import { todoCounts } from '../card-rules'
import { deskDraftsQuery, deskTodoQuery, type DeskDraft, type DeskTodoRow, type TimeoutAction } from '../api'
import { CARD_ACTION_CLASS, DashboardCard, NameAvatar } from '../card-shell'
import { spanText, until } from './time'
import type { CardProps, TFn, TodoTab } from './types'

/** 卡片里最多列几行，再多去审批中心 */
const MAX_ROWS = 6

type RowKind = 'approve' | 'back' | 'draft'

type DeskRow = {
  key: string
  kind: RowKind
  /** 头像用的人名（发起人 / 退回的人 / 自己） */
  avatar: string | null
  title: string
  detail: string | null
  urgent: boolean
  /** 退回原因（红字那一行） */
  note: string | null
  who: string
  when: string
  /** 最近一次谁交过来的 + 怎么交的（转交 / 管理员改派） */
  transferredFrom: string | null
  transferKind: 'transfer' | 'reassign' | null
  due: { at: string; action: TimeoutAction } | null
  instanceId: string | null
  draftCode: string | null
}

const KIND_BADGE: Record<RowKind, { Icon: typeof IconCheck; className: string }> = {
  approve: { Icon: IconCheck, className: 'bg-primary text-primary-foreground' },
  back: { Icon: IconArrowBackUp, className: 'bg-destructive text-white' },
  draft: { Icon: IconPencil, className: 'bg-muted-foreground text-background' },
}

function fromTodo(r: DeskTodoRow, t: TFn): DeskRow {
  const kind: RowKind = r.back ? 'back' : 'approve'
  return {
    key: `task:${r.task_id}`,
    kind,
    avatar: r.back ? r.back_by : r.initiator_name,
    title: r.definition_name ?? r.title,
    detail: r.summary,
    urgent: r.urgent,
    note: r.back ? r.back_reason : null,
    who: r.back
      ? t('{{name}} 退回', { name: r.back_by ?? '—' })
      : [r.initiator_name ?? '—', r.initiator_dept].filter(Boolean).join(' · '),
    when: r.back ? formatDateTimeShort(r.arrived_time) : t('{{when}}到你这', { when: relativeTime(r.arrived_time, t) }),
    transferredFrom: r.transferred_from,
    transferKind: r.transfer_kind,
    due: r.due_time && r.timeout_action ? { at: r.due_time, action: r.timeout_action } : null,
    instanceId: r.id,
    draftCode: null,
  }
}

function fromDraft(d: DeskDraft, me: string | null, t: TFn): DeskRow {
  return {
    key: `draft:${d.code}`,
    kind: 'draft',
    avatar: me,
    title: d.name ?? d.code,
    detail: d.summary,
    urgent: false,
    note: null,
    who: t('你自己'),
    when: t('保存于 {{at}}', { at: formatDateTimeShort(d.updated_time) }),
    transferredFrom: null,
    transferKind: null,
    due: null,
    instanceId: null,
    draftCode: d.code,
  }
}

/** 超时胶囊的文案：按节点超时**动作**出，不是一律「快到期」 */
function dueText(due: { at: string; action: TimeoutAction }, t: TFn): string {
  const left = until(due.at)
  if (left === null) return ''
  if (left <= 0) return t('已超时')
  const when = spanText(left, t)
  if (due.action === 'approve') return t('{{when}}后自动同意', { when })
  if (due.action === 'reject') return t('{{when}}后自动驳回', { when })
  return t('{{when}}后自动提醒', { when })
}

/**
 * 「待我处理」：工作台最显眼的一块（#202）。待审批 · 退回给我 · 草稿，一处看全。
 *
 * - 排序是后端排的（`sort=attention`：加急 → 快到期 → 到手时间），卡片只切分段、截前几行
 * - 待审批 / 退回的「处理」「去修改」**就地**开审批详情抽屉（退回给发起人的那条，抽屉里就是改完重新提交）；
 *   草稿「继续填写」去审批中心的发起抽屉（那里会恢复草稿）
 * - 服务端推 `workflow:todo` 只是「早点重取」，数字靠 REST 取对（同铃铛）
 */
export function TodoCard({ openApproval, todoTab, onTodoTab }: CardProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const me = useQuery(meQuery).data?.nickname ?? null
  const todo = useQuery(deskTodoQuery)
  const drafts = useQuery(deskDraftsQuery)

  useSocketEvent('workflow:todo', () => {
    void qc.invalidateQueries({ queryKey: workflowKeys.counts() })
    void qc.invalidateQueries({ queryKey: workflowKeys.inbox() })
  })

  const todoRows = React.useMemo(() => (todo.data?.items ?? []).map((r) => fromTodo(r, t)), [todo.data, t])
  const draftRows = React.useMemo(() => {
    // 比时间走 `toEpochMs`，不比字符串（i18n 分册：字典序恰好等于时间序是巧合）
    const list = [...(drafts.data ?? [])].sort((a, b) => (toEpochMs(b.updated_time) ?? 0) - (toEpochMs(a.updated_time) ?? 0))
    return list.map((d) => fromDraft(d, me, t))
  }, [drafts.data, me, t])

  // 分段上的数一律是后端给的全量数（`card-rules.todoCounts`），不从取回来的那一页（`DESK_TODO_SIZE` 条）里数
  const full = todo.data ? todoCounts(todo.data) : { total: 0, approve: 0, back: 0 }
  const counts: Record<TodoTab, number> = {
    all: full.total,
    approve: full.approve,
    back: full.back,
    draft: draftRows.length,
  }
  const rows =
    todoTab === 'draft'
      ? draftRows
      : todoTab === 'all'
        ? todoRows
        : todoRows.filter((r) => r.kind === todoTab)

  const tabs: { key: TodoTab; label: string }[] = [
    { key: 'all', label: t('全部') },
    { key: 'approve', label: t('待审批') },
    { key: 'back', label: t('退回给我') },
    { key: 'draft', label: t('草稿') },
  ]
  const emptyText = {
    all: t('手上没有要处理的事'),
    approve: t('没有等你审批的单'),
    back: t('没有被退回的单'),
    draft: t('没有填了一半的草稿'),
  }[todoTab]

  const query = todoTab === 'draft' ? drafts : todo

  return (
    <DashboardCard
      testId="dash-todo"
      title={t('待我处理')}
      headerExtra={
        <div role="tablist" aria-label={t('待我处理')} className="inline-flex gap-0.5 rounded-[10px] bg-muted p-[3px]">
          {tabs.map((tb) => {
            const on = tb.key === todoTab
            return (
              <button
                key={tb.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onTodoTab(tb.key)}
                data-testid={`dash-todo-tab-${tb.key}`}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] transition-colors',
                  on ? 'bg-background font-bold text-foreground shadow-xs' : 'font-medium text-muted-foreground hover:text-foreground'
                )}
              >
                {tb.label}
                <span
                  className={cn(
                    'min-w-[18px] rounded-full px-[5px] text-center text-[11px] leading-[18px] font-bold tabular-nums',
                    on ? 'bg-primary text-primary-foreground' : 'bg-border text-muted-foreground'
                  )}
                  data-testid={`dash-todo-count-${tb.key}`}
                >
                  {counts[tb.key]}
                </span>
              </button>
            )
          })}
        </div>
      }
      action={
        <Link to="/workflow/inbox" search={{ tab: 'todo' }} className={CARD_ACTION_CLASS} data-testid="dash-todo-all">
          {t('审批中心')} →
        </Link>
      }
      footer={
        <>
          <span>{t('加急在前，其次按快到期、到达时间')}</span>
          <Link to="/workflow/inbox" search={{ tab: 'todo' }} className={CARD_ACTION_CLASS}>
            {t('查看全部')} →
          </Link>
        </>
      }
      loading={query.isPending}
      error={todo.error ?? drafts.error}
      onRetry={() => {
        void todo.refetch()
        void drafts.refetch()
      }}
      hasData={Boolean(query.data)}
      empty={rows.length === 0}
      emptyText={emptyText}
      emptyIcon={<IconChecklist className="size-7 text-muted-foreground/60" aria-hidden />}
    >
      <ul className="flex flex-col py-1" data-testid="dash-todo-list">
        {rows.slice(0, MAX_ROWS).map((r) => (
          <TodoRowView key={r.key} row={r} openApproval={openApproval} />
        ))}
      </ul>
    </DashboardCard>
  )
}

function TodoRowView({ row, openApproval }: { row: DeskRow; openApproval: (id: string) => void }) {
  const { t } = useTranslation()
  const kind = KIND_BADGE[row.kind]
  const due = row.due ? dueText(row.due, t) : ''
  const actionCls = cn(
    buttonVariants({ variant: row.kind === 'approve' ? 'default' : 'outline' }),
    'h-[34px] shrink-0 px-4 font-bold'
  )
  return (
    <li
      className={cn(
        'mx-2 flex items-center gap-3.5 rounded-[10px] px-3 py-3.5',
        row.urgent && 'bg-orange-50 dark:bg-orange-500/10'
      )}
      data-testid={`dash-todo-row-${row.key}`}
      data-kind={row.kind}
      data-urgent={row.urgent}
    >
      <span className="relative size-10 shrink-0">
        <NameAvatar name={row.avatar} />
        <span
          className={cn(
            'absolute -end-0.5 -bottom-0.5 grid size-[17px] place-items-center rounded-full border-2 border-card',
            kind.className
          )}
          aria-hidden
        >
          <kind.Icon className="size-2.5" stroke={3} />
        </span>
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold">{row.title}</span>
          {row.detail && (
            <span className="max-w-full truncate rounded-[5px] bg-muted px-[7px] py-px text-xs text-muted-foreground">
              {row.detail}
            </span>
          )}
          {row.urgent && (
            <span className="rounded-[5px] bg-orange-700 px-[7px] py-px text-[11.5px] font-bold text-white">{t('加急')}</span>
          )}
          {row.kind === 'back' && (
            <span className="rounded-[5px] bg-destructive/10 px-[7px] py-px text-[11.5px] font-bold text-destructive">
              {t('退回给你')}
            </span>
          )}
          {row.kind === 'draft' && (
            <span className="rounded-[5px] bg-muted px-[7px] py-px text-[11.5px] font-bold text-muted-foreground">{t('草稿')}</span>
          )}
        </span>
        {row.note && <span className="text-[13px] text-destructive">「{row.note}」</span>}
        <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-[5px]">
            <IconUser className="size-[13px]" aria-hidden />
            {row.who}
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <IconClock className="size-[13px]" aria-hidden />
            {row.when}
          </span>
          {row.transferredFrom && (
            <span className="inline-flex items-center gap-[5px]" data-testid="dash-todo-transferred">
              <IconArrowsExchange className="size-[13px]" aria-hidden />
              {row.transferKind === 'reassign'
                ? t('{{name}} 改派给你', { name: row.transferredFrom })
                : t('{{name}} 转交给你', { name: row.transferredFrom })}
            </span>
          )}
        </span>
      </span>

      {due && (
        <span
          className="inline-flex shrink-0 items-center gap-[5px] rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold whitespace-nowrap text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
          data-testid="dash-todo-due"
        >
          <IconClock className="size-3" stroke={2.4} aria-hidden />
          {due}
        </span>
      )}

      {row.draftCode ? (
        <Link to="/workflow/inbox" search={{ start: row.draftCode }} className={actionCls} data-testid="dash-todo-action">
          {t('继续填写')}
        </Link>
      ) : (
        <Button
          variant={row.kind === 'approve' ? 'default' : 'outline'}
          className="h-[34px] shrink-0 px-4 font-bold"
          onClick={() => row.instanceId && openApproval(row.instanceId)}
          data-testid="dash-todo-action"
        >
          {row.kind === 'approve' ? t('处理') : t('去修改')}
        </Button>
      )}
    </li>
  )
}

