import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@admin/ui/lib/utils'

import { servicesQuery, type ServicesStatus, type ServiceState } from '../api'
import { DashboardCard } from '../card-shell'
import { spanText } from './time'
import type { TFn } from './types'

type ServiceKey = keyof ServicesStatus['services']

const ROWS: { key: ServiceKey; label: string }[] = [
  { key: 'api', label: '接口服务' },
  { key: 'database', label: '数据库' },
  { key: 'redis', label: '缓存' },
  { key: 'scheduler', label: '定时调度' },
  { key: 'worker', label: '后台任务' },
]

const DOT: Record<ServiceState['status'], string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  stale: 'bg-red-500',
  missing: 'bg-red-500',
  // 判断不了（心跳读不到 / 调度器停了看不出 worker）：不冤枉它，也不说它好
  unknown: 'bg-amber-500',
}

function ago(seconds: number, t: TFn): string {
  return seconds < 60 ? t('{{n}} 秒前', { n: seconds }) : t('{{span}}前', { span: spanText(seconds * 1000, t) })
}

function stateText(s: ServiceState, t: TFn): string {
  const seen = s.last_seen_seconds
  switch (s.status) {
    case 'ok':
      return seen == null ? t('正常') : t('心跳 {{ago}}', { ago: ago(seen, t) })
    case 'error':
      return t('连不上')
    case 'stale':
      return seen == null ? t('心跳停了') : t('心跳停在 {{ago}}', { ago: ago(seen, t) })
    case 'missing':
      return t('没有心跳')
    default:
      return t('判断不了')
  }
}

/**
 * 「服务状态」（#202，系统运行区，**只给超管**）：五个服务一行一个 + 在线会话按端拆开。
 *
 * 数据和外部探针 `/api/health/status` 同一套判断（`core/registrar.py` 的那几个 `_check_*`），
 * 多给一份在线会话数。接口是 `DependsSuperUser`（同监控页），所以 `available` 按超管判，不按权限码。
 *
 * ⚠️ 会话索引读不到（Redis 挂了）时 `sessions` 是 `null`，显示「读不到」不显示 0 —— 0 和「不知道」不是一回事（硬纪律 9）
 */
export function ServicesCard() {
  const { t } = useTranslation()
  const query = useQuery(servicesQuery)
  const data = query.data
  const bad = data ? ROWS.filter((r) => data.services[r.key]?.status !== 'ok').length : 0

  return (
    <DashboardCard
      testId="dash-services"
      title={t('服务状态')}
      action={
        data ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-[12.5px] font-bold',
              bad === 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
            )}
            data-testid="dash-services-summary"
          >
            <i
              className={cn(
                'size-2 rounded-full ring-3',
                bad === 0 ? 'bg-emerald-500 ring-emerald-100 dark:ring-emerald-500/20' : 'bg-red-500 ring-red-100 dark:ring-red-500/20'
              )}
            />
            {bad === 0 ? t('全部正常') : t('{{n}} 项异常', { n: bad })}
          </span>
        ) : undefined
      }
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={Boolean(data)}
    >
      {data && (
        <>
          <ul className="flex flex-col px-5 pt-1.5 pb-2">
            {ROWS.map(({ key, label }) => {
              const s = data.services[key] ?? { status: 'unknown' as const }
              return (
                <li
                  key={key}
                  className="flex items-center gap-2.5 border-b border-border/50 py-2.5 last:border-b-0"
                  data-testid={`dash-service-${key}`}
                  data-status={s.status}
                >
                  <i className={cn('size-[7px] shrink-0 rounded-full', DOT[s.status])} aria-hidden />
                  <span className="flex-1 font-semibold">{t(label)}</span>
                  <span className={cn('text-[12.5px]', s.status === 'ok' ? 'text-muted-foreground' : 'font-semibold text-red-700 dark:text-red-400')}>
                    {stateText(s, t)}
                  </span>
                </li>
              )
            })}
          </ul>
          <Sessions sessions={data.sessions} />
        </>
      )}
    </DashboardCard>
  )
}

function Sessions({ sessions }: { sessions: ServicesStatus['sessions'] }) {
  const { t } = useTranslation()
  const parts = sessions
    ? [
        { key: 'web', label: t('网页'), n: sessions.web, className: 'bg-primary' },
        { key: 'desktop', label: t('桌面'), n: sessions.desktop, className: 'bg-primary/40' },
        { key: 'mobile', label: t('移动'), n: sessions.mobile, className: 'bg-amber-500' },
      ]
    : []
  const total = sessions?.total ?? 0
  return (
    <div className="mx-5 mb-[18px] flex items-center gap-3.5 rounded-[10px] bg-muted/60 px-4 py-3.5" data-testid="dash-sessions">
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{t('在线会话')}</span>
        <span className="text-[26px] leading-tight font-extrabold tracking-tight tabular-nums" data-testid="dash-sessions-total">
          {sessions ? sessions.total : '—'}
        </span>
      </span>
      {sessions ? (
        <span className="flex flex-1 flex-col gap-1.5">
          <span className="flex h-2 overflow-hidden rounded bg-border/60">
            {total > 0 &&
              parts.map((p) => (
                <i key={p.key} className={p.className} style={{ width: `${(p.n / total) * 100}%` }} />
              ))}
          </span>
          <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {parts.map((p) => (
              <span key={p.key} data-testid={`dash-sessions-${p.key}`}>
                {p.label} {p.n}
              </span>
            ))}
          </span>
        </span>
      ) : (
        <span className="flex-1 text-xs text-muted-foreground">{t('会话索引读不到（缓存连不上）')}</span>
      )}
    </div>
  )
}
