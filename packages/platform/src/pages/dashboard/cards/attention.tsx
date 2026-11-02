import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconCircleCheck, IconClockExclamation, IconLockExclamation, IconWebhookOff } from '@tabler/icons-react'

import { formatDateTimeShort } from '@admin/i18n'
import { buttonVariants } from '@admin/ui/components/button'
import { cn } from '@admin/ui/lib/utils'

import { usePerm } from '../../../auth/use-perm'
import { attentionQuery, todayRangeParam, type AttentionItem } from '../api'
import { attentionLink } from '../card-rules'
import { CountBadge, DashboardCard } from '../card-shell'
import type { TFn } from './types'

/**
 * 「需要你留意」（#202，系统运行区）：现在就该有人去看一眼的事，一件一行。
 *
 * 三个来源都由后端判断并**按权限过滤**（`GET /sys/dashboard/attention`，见 `app/admin/service/dashboard_service.py`）：
 * 自动停用的 Webhook 端点 · 近 24 小时执行失败的定时任务 · 今天登录失败明显多于近 7 天平均。
 * 没有「账号锁定」那一类：锁定是按 IP + 账号的限流键自己过期的，没有一张能列出来的表。
 *
 * ⚠️ 「去处理 / 看记录 / 看明细」按**目标页的路由守卫**给，不按这一条看不看得见：
 * 能看见登录失败（`log:login:list`）的人不一定进得了登录日志页（守卫要 `log:login:del`），
 * 给一个点进去必然 403 的按钮不如不给
 */
export function AttentionCard() {
  const { t } = useTranslation()
  const query = useQuery(attentionQuery())
  const items = query.data ?? []

  return (
    <DashboardCard
      testId="dash-attention"
      title={t('需要你留意')}
      badge={items.length > 0 ? <CountBadge n={items.length} tone="warning" testId="dash-attention-count" /> : undefined}
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={Boolean(query.data)}
      empty={items.length === 0}
      emptyText={t('没有要你留意的事')}
      emptyIcon={<IconCircleCheck className="size-7 text-emerald-500" aria-hidden />}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((it, i) => (
          <AttentionRow key={`${it.kind}-${i}`} item={it} />
        ))}
      </ul>
    </DashboardCard>
  )
}

const ICON_TONE = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  warning: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
} as const

const ACTION_CLASS = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[30px] shrink-0 px-3 text-[13px] font-bold')

function AttentionRow({ item }: { item: AttentionItem }) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const view = describe(item, t)
  const Icon = view.Icon

  const link = attentionLink(item, can, todayRangeParam(), t)
  // 三种去处的 search 形状各不相同，TanStack 的 `<Link>` 要按 `to` 收窄类型 —— 分开写
  const action: React.ReactNode = !link ? null : link.to === '/open/app' ? (
    <Link to={link.to} search={link.search} className={ACTION_CLASS} data-testid="dash-attention-action">
      {link.label}
    </Link>
  ) : link.to === '/scheduler/record' ? (
    <Link to={link.to} search={link.search} className={ACTION_CLASS} data-testid="dash-attention-action">
      {link.label}
    </Link>
  ) : (
    <Link to={link.to} search={link.search} className={ACTION_CLASS} data-testid="dash-attention-action">
      {link.label}
    </Link>
  )

  return (
    <li className="flex items-start gap-3.5 px-5 py-4" data-testid={`dash-attention-${item.kind}`} data-level={item.level}>
      <span className={cn('grid size-[34px] shrink-0 place-items-center rounded-[9px]', ICON_TONE[item.level])} aria-hidden>
        <Icon className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-bold">{view.title}</span>
          {item.level === 'critical' && (
            <span className="rounded-[5px] bg-red-100 px-1.5 py-px text-[11px] font-bold text-red-700 dark:bg-red-500/15 dark:text-red-300">
              {t('严重')}
            </span>
          )}
        </span>
        {view.detail && <span className="text-[12.5px] text-muted-foreground">{view.detail}</span>}
      </span>
      {action}
    </li>
  )
}

function describe(item: AttentionItem, t: TFn): { Icon: typeof IconCircleCheck; title: string; detail: string | null } {
  switch (item.kind) {
    case 'webhook_disabled':
      return {
        Icon: IconWebhookOff,
        title: t('Webhook 端点「{{name}}」已自动停用', { name: item.name }),
        detail: [
          t('连续 {{n}} 次投递失败后停用', { n: item.failures }),
          item.time ? formatDateTimeShort(item.time) : null,
          t('停用期间事件不会再推给它'),
        ]
          .filter(Boolean)
          .join(' · '),
      }
    case 'task_failed':
      return {
        Icon: IconClockExclamation,
        title:
          item.count > 1
            ? t('定时任务「{{name}}」24 小时内失败了 {{n}} 次', { name: item.name, n: item.count })
            : t('定时任务「{{name}}」执行失败', { name: item.name }),
        detail: [item.time ? t('最近一次 {{at}}', { at: formatDateTimeShort(item.time) }) : null, item.error]
          .filter(Boolean)
          .join(' · '),
      }
    case 'login_fail_spike':
      return {
        Icon: IconLockExclamation,
        title: t('今天 {{n}} 次登录失败，比平时多', { n: item.count }),
        detail: [
          t('近 7 天平均每天 {{n}} 次', { n: item.avg }),
          item.top_ip ? t('其中 {{n}} 次来自 {{ip}}', { n: item.top_ip_count, ip: item.top_ip }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }
  }
}
