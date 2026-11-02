import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconArrowBackUp, IconBell, IconCheck, IconSend, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../../api-client/errors'
import { idempotencyKey, useAct } from '../../workflow/api'
import { deskInitiatedQuery, type InitiatedRow, type StepState } from '../api'
import { lastLine } from '../card-rules'
import { CARD_ACTION_CLASS, DashboardCard } from '../card-shell'
import { DAY, since, spanText } from './time'
import type { CardProps, TFn } from './types'

/** 当前这一步在一个人手上超过这么久，给「催办」 */
const REMIND_AFTER = DAY

type Status = { label: string; className: string }

function statusOf(row: InitiatedRow, t: TFn): Status {
  if (row.back) return { label: t('退回待修改'), className: 'bg-destructive/10 text-destructive' }
  switch (row.status) {
    case 'running':
      return { label: t('审批中'), className: 'bg-primary/10 text-primary' }
    case 'approved':
      return { label: t('已通过'), className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' }
    case 'rejected':
      return { label: t('已驳回'), className: 'bg-destructive/10 text-destructive' }
    case 'withdrawn':
      return { label: t('已撤回'), className: 'bg-muted text-muted-foreground' }
    default:
      return { label: t('已终止'), className: 'bg-muted text-muted-foreground' }
  }
}

/**
 * 「我发起的」（#202）：每张单一个带名字的步骤条 + 状态 + 一行说明，等太久的给「催办」。
 *
 * 🔴 **步骤条只画拿得到的**：走过的（✓）、当前的（带光圈）、后端推演出来的后面几步（灰）。
 * 推演不了（`next_steps: null`，条件用到了发起人看不到的字段）就画一个「…」—— 不编一个后面的步骤出来
 */
export function InitiatedCard({ openApproval }: CardProps) {
  const { t } = useTranslation()
  const query = useQuery(deskInitiatedQuery)
  const rows = query.data?.items ?? []

  return (
    <DashboardCard
      testId="dash-initiated"
      title={t('我发起的')}
      action={
        <Link to="/workflow/inbox" search={{ tab: 'initiated' }} className={CARD_ACTION_CLASS} data-testid="dash-initiated-all">
          {t('全部')}
        </Link>
      }
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={Boolean(query.data)}
      empty={rows.length === 0}
      emptyText={t('你还没有发起过审批')}
      emptyIcon={<IconSend className="size-7 text-muted-foreground/60" aria-hidden />}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {rows.map((r) => (
          <InitiatedItem key={r.id} row={r} onOpen={() => openApproval(r.id)} />
        ))}
      </ul>
    </DashboardCard>
  )
}

function InitiatedItem({ row, onOpen }: { row: InitiatedRow; onOpen: () => void }) {
  const { t } = useTranslation()
  const status = statusOf(row, t)
  const waited = row.arrived_time ? since(row.arrived_time) : null
  const handlers = row.handlers.join('、')

  let line: React.ReactNode
  if (row.back) {
    line = row.resume_to
      ? t('改完重新提交，会直接回到 {{name}}', { name: row.resume_to })
      : t('改完重新提交，从第一步重新审批')
  } else if (row.status === 'running') {
    line = handlers
      ? t('在 {{who}} 手上 · 已等 {{span}}', { who: handlers, span: spanText(waited ?? 0, t) })
      : t('审批中')
  } else if (row.last) {
    line = lastLine(row.last, t)
  }

  const canRemind = row.status === 'running' && !row.back && waited !== null && waited >= REMIND_AFTER

  return (
    <li className="flex flex-col gap-3 px-5 py-4" data-testid={`dash-initiated-${row.id}`}>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-start font-bold hover:text-primary"
          title={row.summary ?? undefined}
        >
          {row.definition_name ?? row.title}
          {row.summary ? <span className="font-normal text-muted-foreground"> · {row.summary}</span> : null}
        </button>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-bold', status.className)} data-testid="dash-initiated-status">
          {status.label}
        </span>
      </span>
      <Steps row={row} />
      {(line || canRemind) && (
        <span className="flex items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
          <span className="min-w-0 truncate">{line}</span>
          {canRemind && <RemindButton instanceId={row.id} />}
        </span>
      )}
    </li>
  )
}

const DOT = 'size-[18px] shrink-0 rounded-full'

function Steps({ row }: { row: InitiatedRow }) {
  const { t } = useTranslation()
  const finished = row.status !== 'running'
  const good = row.status === 'approved'
  const items: { name: string; state: StepState | 'start' | 'back' | 'next' | 'more' }[] = []
  if (row.back) items.push({ name: t('退回到你'), state: 'back' })
  else items.push({ name: t('发起'), state: 'start' })
  if (!row.back) items.push(...row.steps)
  if (!finished) {
    if (row.next_steps === null) items.push({ name: '…', state: 'more' })
    else items.push(...row.next_steps.map((n) => ({ name: n, state: 'next' as const })))
  }

  const doneDot = good ? 'bg-emerald-500' : 'bg-primary'
  const doneLine = good ? 'bg-emerald-300 dark:bg-emerald-500/60' : 'bg-primary'
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="dash-initiated-steps">
      {items.map((it, i) => {
        const prevDone = i > 0 && ['start', 'done'].includes(items[i - 1]!.state)
        return (
          <React.Fragment key={`${i}-${it.name}`}>
            {i > 0 && (
              <i
                className={cn(
                  'h-0.5 min-w-3 flex-1 rounded-full',
                  items[i - 1]!.state === 'back' ? 'bg-destructive/30' : prevDone && it.state !== 'next' && it.state !== 'more' ? doneLine : 'bg-border'
                )}
              />
            )}
            {it.state === 'start' || it.state === 'done' ? (
              <span className={cn(DOT, 'grid place-items-center', doneDot)} aria-hidden>
                <IconCheck className="size-2.5 text-white" stroke={3.4} />
              </span>
            ) : it.state === 'current' ? (
              <span className={cn(DOT, 'border-2 border-primary bg-background ring-3 ring-primary/20')} aria-hidden />
            ) : it.state === 'rejected' ? (
              <span className={cn(DOT, 'grid place-items-center bg-destructive')} aria-hidden>
                <IconX className="size-2.5 text-white" stroke={3.4} />
              </span>
            ) : it.state === 'back' || it.state === 'sent_back' ? (
              <span className={cn(DOT, 'grid place-items-center bg-destructive')} aria-hidden>
                <IconArrowBackUp className="size-2.5 text-white" stroke={3} />
              </span>
            ) : (
              <span className={cn(DOT, 'border-2 border-dashed border-border bg-background', it.state === 'next' && 'border-solid')} aria-hidden />
            )}
            <span
              className={cn(
                'shrink-0 truncate',
                it.state === 'current' && 'font-bold text-foreground',
                it.state === 'back' && 'font-bold text-destructive',
                it.state === 'sent_back' && 'text-destructive'
              )}
              title={it.state === 'more' ? t('后面还有几步要看审批结果') : it.state === 'sent_back' ? t('这一步退回了') : undefined}
              data-state={it.state}
            >
              {it.name}
            </span>
          </React.Fragment>
        )
      })}
    </span>
  )
}

function RemindButton({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation()
  const act = useAct(instanceId)
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2.5 text-xs font-semibold"
      disabled={act.isPending}
      onClick={() =>
        act.mutate(
          { action: 'remind', key: idempotencyKey() },
          {
            onSuccess: () => toast.success(t('已催办')),
            onError: (e) => toast.error(e instanceof ApiError ? e.message : t('催办失败，请稍后重试')),
          }
        )
      }
      data-testid="dash-initiated-remind"
    >
      <IconBell className="size-3" aria-hidden />
      {t('催办')}
    </Button>
  )
}
