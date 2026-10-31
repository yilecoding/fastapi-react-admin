import * as React from 'react'
import { formatDateTimeShort, formatNumber } from '@admin/i18n'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconActivity, IconArrowRight, IconChartBar, IconHistory, IconLogin } from '@tabler/icons-react'

import { Alert } from '@admin/ui/components/alert'
import { Badge } from '@admin/ui/components/badge'
import { Skeleton } from '@admin/ui/components/skeleton'

import { usePerm } from '../../../auth/use-perm'
import { StatusPill } from '../../_shared/status'
import {
  loginTrendQuery, onlineCountQuery, recentLoginsQuery, recentOperasQuery,
  scaleCountQuery, todayCountQuery, todayRangeParam,
  type DayPoint,
} from '../api'
import { CARD_ACTION_CLASS, DashboardCard } from '../card-shell'

/*
 * 管理员看板那几张卡（#202 之前它们挤在一页里，普通员工打开是一排「没有权限」）。
 *
 * ⚠️ 后端**没有统计接口**，每个数字都是拿列表接口的 `total` 拼出来的（见 `api.ts`）。
 * 它们回答的是「此刻平台在发生什么」，不是 BI 报表。
 *
 * 权限判据和接口守卫一致：登录日志 `log:login:list`、操作日志 `log:opera:list`、用户 `sys:user:list`、
 * 角色 `sys:role:list`、在线会话超管。🔴 **日志页的链接另看 `log:*:del`** —— 那是日志页路由守卫要的码，
 * 只有 list 没有 del 的人点过去只会落到 /403，那就不给链接（数字照样显示）。
 */

/* ────────────────────────── 今日指标 ────────────────────────── */

/**
 * 今日指标：每一格按权限决定发不发请求、画不画 —— 没权限的那一格**不画**（不再是「仅超级管理员可见」）。
 * 任一格的查询失败都把错误块顶在卡片上方（硬纪律 9：「今日登录 —」和「今天真的零次登录」分不出来）。
 */
export function MetricsCard() {
  const { t } = useTranslation()
  const { can, isSuperuser } = usePerm()
  const canLogin = can('log:login:list')
  const canOpera = can('log:opera:list')
  const canUsers = can('sys:user:list')
  const canRoles = can('sys:role:list')

  const logins = useQuery({ ...todayCountQuery('login'), enabled: canLogin })
  const operas = useQuery({ ...todayCountQuery('opera'), enabled: canOpera })
  const users = useQuery({ ...scaleCountQuery('users'), enabled: canUsers })
  const roles = useQuery({ ...scaleCountQuery('roles'), enabled: canRoles })
  const notices = useQuery(scaleCountQuery('notices'))
  // 在线会话是超管专属接口，非超管直接不发请求（发了就是一条必然 403 的噪音）
  const online = useQuery({ ...onlineCountQuery, enabled: isSuperuser })

  /** 跳日志页用的时间参数：一个 `time=起~止`，不是 start_time + end_time */
  const timeParam = React.useMemo(() => todayRangeParam(), [])
  const linkLogin = can('log:login:del')
  const linkOpera = can('log:opera:del')

  // disabled 的查询永远不会有 error，不用单独排除
  const queries = [logins, operas, users, roles, notices, online]
  const failed = queries.filter((q) => q.error)
  const fails = logins.data?.fails ?? 0

  return (
    <DashboardCard
      testId="dash-metrics"
      title={t('今日指标')}
      icon={<IconActivity className="size-4 text-primary" aria-hidden />}
      error={failed[0]?.error}
      onRetry={() => failed.forEach((q) => void q.refetch())}
      hasData
    >
      {/* 今日有登录失败就顶上去 —— 这是这张卡最该被看见的一条 */}
      {fails > 0 && (
        <Alert tone="warning" data-testid="dash-fail-alert" className="items-center [&>div]:flex-row [&>div]:flex-wrap [&>div]:items-center [&>div]:gap-2">
          {/* 整句一个 key —— 拆成「前半 t() + <strong> + 后半 t()」换英文语序就散架 */}
          <span>
            <Trans
              t={t}
              i18nKey="今日有 <b>{{n}}</b> 次登录失败。"
              values={{ n: fails }}
              components={{ b: <strong className="tabular-nums" /> }}
            />
          </span>
          {linkLogin && (
            <Link
              to="/log/login"
              search={{ status: 0, time: timeParam }}
              className="inline-flex items-center gap-1 underline underline-offset-2"
              data-testid="dash-fail-link"
            >
              {t('查看明细')} <IconArrowRight className="size-3.5" />
            </Link>
          )}
        </Alert>
      )}

      <div className="grid gap-3 @2xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {canLogin && (
          <Metric
            label={t('今日登录')} value={logins.data?.total} loading={logins.isPending}
            testId="metric-logins"
            hint={fails > 0 ? t('其中 {{n}} 次失败', { n: fails }) : t('全部成功')}
            tone={fails > 0 ? 'warning' : 'success'}
            to={linkLogin ? { path: '/log/login', search: { time: timeParam } } : undefined}
          />
        )}
        {canOpera && (
          <Metric
            label={t('今日操作')} value={operas.data?.total} loading={operas.isPending}
            testId="metric-operations"
            hint={operas.data?.fails ? t('其中 {{n}} 次异常', { n: operas.data.fails }) : t('无异常')}
            tone={operas.data?.fails ? 'warning' : 'success'}
            to={linkOpera ? { path: '/log/opera', search: { time: timeParam } } : undefined}
          />
        )}
        {canUsers && (
          <Metric
            label={t('用户总数')} value={users.data} loading={users.isPending}
            testId="metric-users"
            hint={
              canRoles && roles.data !== undefined && notices.data !== undefined
                ? t('{{roles}} 个角色 · {{notices}} 条公告', { roles: roles.data, notices: notices.data })
                : undefined
            }
          />
        )}
        {isSuperuser && (
          <Metric
            label={t('在线会话')} value={online.data} loading={online.isPending}
            testId="metric-online"
            hint={t('Redis 中未过期的 token 数')}
            to={{ path: '/monitor/online', search: {} }}
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground" data-testid="dash-disclaimer">
        {t('指标由各列表接口的分页总数实时算出，后端没有统计表 —— 数字反映当前库里的记录，不做缓存快照。')}
      </p>
    </DashboardCard>
  )
}

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

  const cls = 'flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2.5'
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

/* ────────────────────────── 近 7 天登录 ────────────────────────── */

export function LoginTrendCard() {
  const { t } = useTranslation()
  const trend = useQuery(loginTrendQuery)
  return (
    <DashboardCard
      testId="dash-trend"
      title={t('近 7 天登录')}
      icon={<IconChartBar className="size-4 text-primary" aria-hidden />}
      note={
        trend.data?.truncated
          ? t('按天统计 · 失败明细只取了最近 200 条（共 {{n}} 条）', { n: trend.data.failTotal })
          : t('按天统计，红色为失败')
      }
      loading={trend.isPending}
      error={trend.error}
      onRetry={() => void trend.refetch()}
      hasData={Boolean(trend.data)}
    >
      {trend.data && <TrendBars points={trend.data.points} />}
    </DashboardCard>
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

/* ────────────────────────── 最近登录 / 最近操作 ────────────────────────── */

export function RecentLoginsCard() {
  const { t } = useTranslation()
  const { can } = usePerm()
  const logins = useQuery(recentLoginsQuery)
  const items = logins.data ?? []
  return (
    <DashboardCard
      testId="dash-recent-logins"
      title={t('最近登录')}
      icon={<IconLogin className="size-4 text-primary" aria-hidden />}
      action={
        can('log:login:del') ? (
          <Link to="/log/login" search={{}} className={CARD_ACTION_CLASS}>
            {t('全部')}
          </Link>
        ) : undefined
      }
      loading={logins.isPending}
      error={logins.error}
      onRetry={() => void logins.refetch()}
      hasData={Boolean(logins.data)}
      empty={items.length === 0}
      emptyText={t('暂无登录记录')}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((l) => (
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
    </DashboardCard>
  )
}

export function RecentOperasCard() {
  const { t } = useTranslation()
  const { can } = usePerm()
  const operas = useQuery(recentOperasQuery)
  const items = operas.data ?? []
  return (
    <DashboardCard
      testId="dash-recent-operas"
      title={t('最近操作')}
      icon={<IconHistory className="size-4 text-primary" aria-hidden />}
      action={
        can('log:opera:del') ? (
          <Link to="/log/opera" search={{}} className={CARD_ACTION_CLASS}>
            {t('全部')}
          </Link>
        ) : undefined
      }
      loading={operas.isPending}
      error={operas.error}
      onRetry={() => void operas.refetch()}
      hasData={Boolean(operas.data)}
      empty={items.length === 0}
      emptyText={t('暂无操作记录')}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((o) => (
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
    </DashboardCard>
  )
}
