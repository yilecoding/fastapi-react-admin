import * as React from 'react'
import { formatDateTime, formatDateTimeShort, formatNumber } from '@admin/i18n'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconAlertTriangle, IconArrowRight, IconLoader2, IconRefresh,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { meQuery } from '../../auth/queries'
import { usePerm } from '../../auth/use-perm'
import { PageHeader } from '../../shell/page-header'
import { StatusPill } from '../_shared/status'
import {
  loginTrendQuery, onlineCountQuery, recentLoginsQuery, recentOperasQuery,
  scaleStatsQuery, todayRangeParam, todayStatsQuery,
  type DayPoint,
} from './api'

/**
 * 仪表盘（平台首页）。
 *
 * ⚠️ 后端**没有统计接口**，这一页的每个数字都是拿列表接口的 `total` 拼出来的
 * （见 `api.ts`）。所以它回答的是「此刻平台在发生什么」，不是 BI 报表：
 * 没有留存、没有同比、没有按维度下钻。要那些得先给后端加聚合端点。
 *
 * 硬纪律：组件 router-独立 —— 这里只用 `<Link>`（组件，走 router context 而非
 * match context，隐藏 tab 里照样可用），不调 `useNavigate()`。
 */
export function DashboardPage() {
  const { t } = useTranslation()
  const { data: me } = useQuery(meQuery)
  const { isSuperuser, can } = usePerm()

  const today = useQuery(todayStatsQuery)
  const scale = useQuery(scaleStatsQuery)
  const trend = useQuery(loginTrendQuery)
  const logins = useQuery(recentLoginsQuery)
  const operas = useQuery(recentOperasQuery)
  // 在线会话是超管专属接口，非超管直接不发请求（发了就是一条必然 403 的噪音）
  const online = useQuery({ ...onlineCountQuery, enabled: isSuperuser })

  /** 跳日志页用的时间参数：一个 `time=起~止`，不是 start_time + end_time */
  const timeParam = React.useMemo(() => todayRangeParam(), [])
  // 日志页的路由守卫要 log:*:del，没这个权限点过去只会落到 /403 —— 那就别给链接
  const canLoginLog = can('log:login:del')
  const canOperaLog = can('log:opera:del')

  const refreshing =
    today.isFetching || scale.isFetching || trend.isFetching || logins.isFetching || operas.isFetching
  const refetchAll = () => {
    void today.refetch(); void scale.refetch(); void trend.refetch()
    void logins.refetch(); void operas.refetch()
    if (isSuperuser) void online.refetch()
  }

  const fails = today.data?.loginFails ?? 0

  /**
   * 🔴 这一页的每个数字都取自独立的一个查询，失败时全都退化成「—」（硬纪律 9）：
   * 「今日登录 —」和「今日真的一次登录都没有」在界面上分不出来。
   * 所以只要有一个查询挂了就把它顶到页头下面，重试复用「刷新」那条链。
   * `online` 对非超管是 disabled 的（永远不会有 error），不用单独排除。
   */
  const firstError = [today, scale, trend, logins, operas, online].find((q) => q.error)?.error

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader title={t("仪表盘")} description={t("平台首页：今日活动、近 7 天趋势与最近动态。")} />

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-lg font-semibold" data-testid="dash-greeting">
                {t('你好，{{name}}', { name: me?.nickname ?? '…' })}
              </span>
              <span className="text-sm text-muted-foreground">
                {me?.last_login_time
                  ? t('上次登录 {{at}}', { at: formatDateTime(me.last_login_time) })
                  : t('欢迎回来')}
                {me?.dept ? ` · ${me.dept}` : ''}
              </span>
            </div>
            <Button
              variant="outline" size="sm" data-testid="dash-refresh"
              disabled={refreshing} onClick={refetchAll}
            >
              {refreshing ? <IconLoader2 className="size-4 animate-spin" /> : <IconRefresh className="size-4" />}
              {t('刷新')}
            </Button>
          </div>

          {Boolean(firstError) && (
            <QueryError error={firstError} onRetry={refetchAll} testId="dash-error" />
          )}

          {/* 今日有登录失败就顶上去 —— 这是这一页最该被看见的一条 */}
          {fails > 0 && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
              data-testid="dash-fail-alert"
            >
              <IconAlertTriangle className="size-4 shrink-0" />
              {/* 整句一个 key —— 拆成「前半 t() + <strong> + 后半 t()」换英文语序就散架 */}
              <span>
                <Trans
                  t={t}
                  i18nKey="今日有 <b>{{n}}</b> 次登录失败。"
                  values={{ n: fails }}
                  components={{ b: <strong className="tabular-nums" /> }}
                />
              </span>
              {canLoginLog && (
                <Link
                  to="/log/login"
                  search={{ status: 0, time: timeParam }}
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                  data-testid="dash-fail-link"
                >
                  {t('查看明细')} <IconArrowRight className="size-3.5" />
                </Link>
              )}
            </div>
          )}

          {/* ── 今日指标 ── */}
          <div className="grid gap-4 @2xl/main:grid-cols-2 @5xl/main:grid-cols-4" data-testid="dash-metrics">
            <Metric
              label={t("今日登录")} value={today.data?.logins} loading={today.isPending}
              testId="metric-logins"
              hint={fails > 0 ? t('其中 {{n}} 次失败', { n: fails }) : t('全部成功')}
              tone={fails > 0 ? 'warning' : 'success'}
              to={canLoginLog ? { path: '/log/login', search: { time: timeParam } } : undefined}
            />
            <Metric
              label={t("今日操作")} value={today.data?.operations} loading={today.isPending}
              testId="metric-operations"
              hint={today.data?.operaFails ? t('其中 {{n}} 次异常', { n: today.data.operaFails }) : t('无异常')}
              tone={today.data?.operaFails ? 'warning' : 'success'}
              to={canOperaLog ? { path: '/log/opera', search: { time: timeParam } } : undefined}
            />
            <Metric
              label={t("用户总数")} value={scale.data?.users} loading={scale.isPending}
              testId="metric-users"
              hint={scale.data ? t('{{roles}} 个角色 · {{notices}} 条公告', { roles: scale.data.roles, notices: scale.data.notices }) : undefined}
            />
            {isSuperuser ? (
              <Metric
                label={t("在线会话")} value={online.data} loading={online.isPending}
                testId="metric-online"
                hint={t("Redis 中未过期的 token 数")}
                to={{ path: '/monitor/online', search: {} }}
              />
            ) : (
              <div
                className="flex flex-col justify-center gap-1 rounded-lg border border-dashed border-border px-4 py-3"
                data-testid="metric-online-denied"
              >
                <span className="text-xs text-muted-foreground">{t('在线会话')}</span>
                {/* 没权限要说「没权限」，不能装成 0 或者干脆不画这一格 */}
                <span className="text-sm text-muted-foreground">{t('仅超级管理员可见')}</span>
              </div>
            )}
          </div>

          {/* ── 近 7 天登录趋势 ── */}
          <Panel
            title={t("近 7 天登录")}
            note={
              trend.data?.truncated
                ? t('按天统计 · 失败明细只取了最近 200 条（共 {{n}} 条）', { n: trend.data.failTotal })
                : t('按天统计，红色为失败')
            }
            testId="dash-trend"
            loading={trend.isPending}
          >
            {trend.data && <TrendBars points={trend.data.points} />}
          </Panel>

          {/* ── 最近动态 ── */}
          <div className="grid gap-4 @4xl/main:grid-cols-2">
            <Panel
              title={t("最近登录")}
              testId="dash-recent-logins"
              loading={logins.isPending}
              action={
                canLoginLog ? (
                  <Link to="/log/login" search={{}} className="text-xs text-primary underline-offset-2 hover:underline">
                    {t('全部')}
                  </Link>
                ) : undefined
              }
            >
              {logins.data?.length ? (
                <ul className="flex flex-col divide-y divide-border/60">
                  {logins.data.map((l) => (
                    <li key={l.id} className="flex items-center gap-2 py-1.5 text-sm">
                      {l.status === 1
                        ? <StatusPill tone="success">{t('成功')}</StatusPill>
                        : <StatusPill tone="danger">{t('失败')}</StatusPill>}
                      <span className="min-w-0 flex-1 truncate">{l.username}</span>
                      <span className="hidden font-mono text-xs text-muted-foreground @xl/main:inline">{l.ip}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDateTimeShort(l.login_time)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>{t('暂无登录记录')}</Empty>
              )}
            </Panel>

            <Panel
              title={t("最近操作")}
              testId="dash-recent-operas"
              loading={operas.isPending}
              action={
                canOperaLog ? (
                  <Link to="/log/opera" search={{}} className="text-xs text-primary underline-offset-2 hover:underline">
                    {t('全部')}
                  </Link>
                ) : undefined
              }
            >
              {operas.data?.length ? (
                <ul className="flex flex-col divide-y divide-border/60">
                  {operas.data.map((o) => (
                    <li key={o.id} className="flex items-center gap-2 py-1.5 text-sm">
                      <Badge variant="outline" className="shrink-0 font-mono text-2xs font-normal">
                        {o.method}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate" title={o.path}>{o.title ? t(o.title) : o.path}</span>
                      <span className="hidden shrink-0 text-xs text-muted-foreground @xl/main:inline">
                        {o.username ?? '—'}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDateTimeShort(o.opera_time)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>{t('暂无操作记录')}</Empty>
              )}
            </Panel>
          </div>

          <p className="text-xs text-muted-foreground" data-testid="dash-disclaimer">
            {t('指标由各列表接口的分页总数实时算出，后端没有统计表 —— 数字反映当前库里的记录，不做缓存快照。')}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────── 小件 ────────────────────────── */

function Metric({
  label, value, hint, loading, tone, testId, to,
}: {
  label: string
  value: number | undefined
  hint?: string
  loading: boolean
  tone?: 'success' | 'warning'
  testId: string
  to?: { path: '/log/login' | '/log/opera' | '/monitor/online'; search: Record<string, unknown> }
}) {
  const body = (
    <>
      <span className="text-xs text-muted-foreground">{label}</span>
      {loading ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <span className="text-2xl font-semibold tabular-nums" data-testid={`${testId}-value`}>
          {value === undefined ? '—' : formatNumber(value)}
        </span>
      )}
      {hint && (
        <span
          className={
            tone === 'warning'
              ? 'text-xs text-amber-700 dark:text-amber-300'
              : 'text-xs text-muted-foreground'
          }
        >
          {hint}
        </span>
      )}
    </>
  )

  const cls = 'flex flex-col gap-1 rounded-lg border border-border px-4 py-3'
  if (!to) return <div className={cls} data-testid={testId}>{body}</div>
  return (
    <Link
      to={to.path as never}
      search={to.search as never}
      className={`${cls} transition-colors hover:border-primary/40 hover:bg-muted/40`}
      data-testid={testId}
    >
      {body}
    </Link>
  )
}

function Panel({
  title, note, action, loading, testId, children,
}: {
  title: string
  note?: string
  action?: React.ReactNode
  loading: boolean
  testId: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{title}</span>
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
        {action}
      </div>
      {loading ? <Skeleton className="h-24 w-full" /> : children}
    </div>
  )
}

/**
 * 7 根柱子的极简条形图。
 *
 * 不用 recharts：`ResponsiveContainer` 要测容器宽度，而隐藏的 tab 是
 * `display:none`（宽度 0），切回来会画成一条线。这里是纯 flex + 百分比高度，
 * 不做任何测量。（和监控页的 `Sparkline` 是同一个理由。）
 */
function TrendBars({ points }: { points: DayPoint[] }) {
  const { t } = useTranslation()
  const top = Math.max(1, ...points.map((p) => p.total))
  return (
    <div className="flex items-end gap-2" data-testid="trend-bars">
      {points.map((p) => {
        const okH = ((p.total - p.fails) / top) * 100
        const failH = (p.fails / top) * 100
        return (
          <div key={p.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="text-xs tabular-nums text-muted-foreground" data-testid={`trend-total-${p.date}`}>
              {p.total}
            </span>
            <div className="flex h-24 w-full flex-col justify-end gap-px" title={t('{{date}}：{{total}} 次，其中失败 {{fails}} 次', { date: p.date, total: p.total, fails: p.fails })}>
              {p.fails > 0 && (
                <div className="w-full rounded-t bg-destructive/70" style={{ height: `${failH}%` }} />
              )}
              <div
                className={`w-full bg-sky-500/70 ${p.fails > 0 ? '' : 'rounded-t'}`}
                style={{ height: `${okH}%` }}
              />
            </div>
            <span className="truncate text-2xs tabular-nums text-muted-foreground">{p.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}
