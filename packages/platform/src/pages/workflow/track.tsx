import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconArrowForwardUp, IconCheck, IconClockHour4, IconCopy, IconDots, IconFlag, IconPlayerSkipForward, IconSend,
  IconUserQuestion, IconX,
} from '@tabler/icons-react'

import { cn } from '@admin/ui/lib/utils'
import { formatDateTimeShort } from '@admin/i18n'

/**
 * 审批轨道 —— 发起页的「流程预告」和详情页的「审批进度」是同一个东西的两个时态：
 * 一条竖线，每一步一个状态标记，下面是这一步的人和他们的结果。
 *
 * 飞书审批里最常被看的就是这一块（「现在卡在谁那儿」「后面还要谁批」），
 * 所以它是整套审批界面里唯一做得比较重的元素；其余地方保持安静。
 */

export type TrackState = 'done' | 'current' | 'rejected' | 'future' | 'skipped' | 'warn' | 'withdrawn'

export type TrackPerson = {
  name: string
  /** 这个人在这一步的结果，显示在名字后面 */
  result?: { text: string; tone: 'ok' | 'bad' | 'muted' | 'pending' }
  time?: string | null
  opinion?: string | null
}

export type TrackItem = {
  key: string
  kind: 'start' | 'approval' | 'cc' | 'system' | 'end'
  title: string
  /** 标题后的小字：会签 / 或签 / 自动跳过 / 发起人自选… */
  tag?: string
  state: TrackState
  people?: TrackPerson[]
  /** 没有人可显示时的一句话（「找不到审批人，将自动驳回」） */
  note?: string
  time?: string | null
}

const MARK: Record<TrackState, { cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  done: { cls: 'bg-emerald-500 text-white', icon: IconCheck },
  current: { cls: 'bg-amber-500 text-white ring-4 ring-amber-500/20', icon: IconClockHour4 },
  rejected: { cls: 'bg-destructive text-white', icon: IconX },
  withdrawn: { cls: 'bg-muted-foreground text-white', icon: IconArrowForwardUp },
  future: { cls: 'border border-dashed border-muted-foreground/50 bg-card text-muted-foreground', icon: IconDots },
  skipped: { cls: 'border border-border bg-muted text-muted-foreground', icon: IconPlayerSkipForward },
  warn: { cls: 'bg-destructive/10 text-destructive ring-1 ring-destructive/30', icon: IconUserQuestion },
}

const KIND_ICON = { start: IconSend, cc: IconCopy, end: IconFlag } as const

export function ApprovalTrack({ items, testId = 'wf-track' }: { items: TrackItem[]; testId?: string }) {
  return (
    <ol className="relative flex flex-col" data-testid={testId}>
      {items.map((it, i) => (
        <TrackRow key={it.key} item={it} last={i === items.length - 1} />
      ))}
    </ol>
  )
}

function TrackRow({ item: it, last }: { item: TrackItem; last: boolean }) {
  const mark = MARK[it.state]
  const KindIcon = it.kind in KIND_ICON ? KIND_ICON[it.kind as keyof typeof KIND_ICON] : null
  const Icon = it.state === 'done' && KindIcon ? KindIcon : mark.icon
  const future = it.state === 'future' || it.state === 'skipped'
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0" data-state={it.state} data-testid={`wf-track-${it.key}`}>
      {/* 竖线：已经走过的那一段用实线，后面的用虚线 —— 一眼看出「走到哪了」 */}
      {!last && (
        <span
          aria-hidden
          className={cn(
            'absolute start-[0.6875rem] top-7 bottom-0 w-px',
            future || it.state === 'current' ? 'border-s border-dashed border-border' : 'bg-emerald-500/40'
          )}
        />
      )}
      <span className={cn('relative z-10 grid size-6 shrink-0 place-items-center rounded-full', mark.cls)}>
        <Icon className="size-3.5" />
      </span>
      <div className={cn('flex min-w-0 flex-1 flex-col gap-1.5', future && 'opacity-70')}>
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{it.title}</span>
          {it.tag && <span className="shrink-0 text-xs text-muted-foreground">{it.tag}</span>}
          {it.time && (
            <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTimeShort(it.time)}</span>
          )}
        </div>
        {it.note && (
          <p className={cn('text-xs', it.state === 'warn' || it.state === 'rejected' ? 'text-destructive' : 'text-muted-foreground')}>
            {it.note}
          </p>
        )}
        {!!it.people?.length && (
          <ul className="flex flex-col gap-1.5">
            {it.people.map((p, i) => (
              <li key={`${p.name}-${i}`} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm">
                  <PersonAvatar name={p.name} />
                  <span className="truncate">{p.name}</span>
                  {p.result && <ResultTag {...p.result} />}
                  {p.time && <span className="ms-auto text-xs text-muted-foreground tabular-nums">{formatDateTimeShort(p.time)}</span>}
                </span>
                {p.opinion && (
                  <p className="ms-8 rounded-md bg-muted/60 px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words">{p.opinion}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

function ResultTag({ text, tone }: { text: string; tone: 'ok' | 'bad' | 'muted' | 'pending' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 text-xs leading-5',
        tone === 'ok' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        tone === 'bad' && 'bg-destructive/10 text-destructive',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'pending' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      )}
    >
      {text}
    </span>
  )
}

/**
 * 名字首字的圆头像。色相由名字算出来、固定不变 —— 同一个人在轨道、列表、通知里是同一个颜色，
 * 扫一眼就能认出「又是他」。
 */
export function PersonAvatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation()
  const label = name || t('未知')
  let h = 0
  for (const ch of label) h = (h * 31 + ch.codePointAt(0)!) % 360
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-medium select-none',
        size === 'sm' && 'size-7 text-[10px]',
        size === 'md' && 'size-8 text-xs',
        size === 'lg' && 'size-10 text-sm'
      )}
      style={{ backgroundColor: `oklch(0.9 0.06 ${h})`, color: `oklch(0.38 0.11 ${h})` }}
    >
      {[...label].slice(-2).join('')}
    </span>
  )
}

/** 流程模板的方块图标：取名字首字，色相按分组算 —— 同一组的模板颜色一致 */
export function TemplateTile({ name, group, size = 'md' }: { name: string; group?: string | null; size?: 'md' | 'lg' }) {
  let h = 210
  for (const ch of group || name) h = (h * 17 + ch.codePointAt(0)!) % 360
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-xl font-semibold text-white shadow-xs',
        size === 'md' ? 'size-9 text-sm' : 'size-11 text-base'
      )}
      style={{ background: `linear-gradient(135deg, oklch(0.68 0.15 ${h}), oklch(0.56 0.16 ${(h + 25) % 360}))` }}
    >
      {[...name][0]}
    </span>
  )
}

/** 加急标记：列表行和详情头部共用 */
export function UrgentTag() {
  const { t } = useTranslation()
  return (
    <span className="shrink-0 rounded bg-red-500/10 px-1.5 text-xs leading-5 font-medium text-red-600 dark:text-red-400" data-testid="wf-urgent">
      {t('加急')}
    </span>
  )
}

