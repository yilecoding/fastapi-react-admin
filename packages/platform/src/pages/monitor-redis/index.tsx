import * as React from 'react'
import { formatDuration, formatNumber } from '@admin/i18n'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconBolt, IconChartBar, IconDatabase, IconHash, IconNetwork, IconServer,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'

import { PageHeader } from '../../shell/page-header'
import { TextFilter } from '../_shared/filters'
import {
  BarList, DEFAULT_REFRESH, InfoCard, InfoRow, MetricCard, MonitorError,
  MonitorSkeleton, RefreshBar, Sparkline, useSamples,
} from '../_shared/monitor'
import { StatusPill } from '../_shared/status'
import {
  fragmentationHint, int, num, redisKeys, redisMonitorQuery,
} from './api'

/**
 * Redis 监控。
 *
 * 硬纪律：组件 router-独立（search 走 props），视图状态（刷新间隔 / 命令搜索）进 URL。
 *
 * 注意本项目的 Redis 是 `fba_redis` 容器，宿主映射 **6380**，容器内仍是 6379 ——
 * 页面上「监听端口」显示的是容器内视角的 6379，不是你 redis-cli 连的那个端口。
 */
export type MonitorRedisSearch = {
  refresh?: number
  /** 命令统计的搜索词 */
  cmd?: string
  /** 命令统计是否展开全部（默认只看前 10） */
  all?: number
}

const TOP_N = 10

export function MonitorRedisPage({
  search = {},
  onSearchChange,
}: {
  search?: MonitorRedisSearch
  onSearchChange?: (n: MonitorRedisSearch) => void
}) {
  const { t } = useTranslation()
  const refresh = search.refresh ?? DEFAULT_REFRESH
  const showAll = search.all === 1
  const qc = useQueryClient()
  const { data, isPending, isFetching, error, dataUpdatedAt } = useQuery(redisMonitorQuery(refresh * 1000))

  const patch = React.useCallback(
    (n: Partial<MonitorRedisSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  const info = data?.info
  const qps = num(info?.instantaneous_ops_per_sec)
  const qpsHistory = useSamples(info ? qps : undefined, dataUpdatedAt)
  const frag = num(info?.mem_fragmentation_ratio)
  const fragMeta = fragmentationHint(frag)
  const noLimit = !info?.maxmemory_human || info.maxmemory_human === '0B'

  // 命令统计：按调用次数倒序。后端给的是 dict 迭代序，不排就是随机顺序
  const commands = React.useMemo(() => {
    const list = (data?.stats ?? []).map((s) => ({ name: s.name, value: num(s.value) }))
    list.sort((a, b) => b.value - a.value)
    const kw = (search.cmd ?? '').trim().toLowerCase()
    return kw ? list.filter((c) => c.name.toLowerCase().includes(kw)) : list
  }, [data, search.cmd])

  const visible = showAll ? commands : commands.slice(0, TOP_N)
  const totalCalls = React.useMemo(() => commands.reduce((s, c) => s + c.value, 0), [commands])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader title={t("Redis 监控")} description={t("缓存实例的实时状态。会话、验证码、权限缓存都落在这里。")}>
            <RefreshBar
              interval={refresh}
              updatedAt={dataUpdatedAt || undefined}
              fetching={isFetching}
              onIntervalChange={(v) => patch({ refresh: v })}
              onRefresh={() => void qc.invalidateQueries({ queryKey: redisKeys.all })}
            />
          </PageHeader>

          {error && <MonitorError error={error} />}
          {isPending && !error && <MonitorSkeleton />}

          {/* 内部 gap 用 gap-4 md:gap-6 —— 与外层页面容器同一个节奏。
              原来只写 gap-4，于是「页头 → 第一块」是 24px、
              「块与块之间」却是 16px，同一页两种间距 */}
          {info && (
            <div className="flex flex-col gap-4 md:gap-6" data-testid="redis-monitor" data-fetching={isFetching}>
              {/* ── 四个顶层指标 ── */}
              <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @4xl/main:grid-cols-4">
                <MetricCard
                  label={t("已使用内存")}
                  testId="metric-memory"
                  value={info.used_memory_human}
                  tone="info"
                  hint={noLimit ? t('未设置 maxmemory 上限') : t('上限 {{v}}', { v: info.maxmemory_human })}
                />
                <MetricCard
                  label={t("键总数")}
                  testId="metric-keys"
                  value={int(info.keys_num)}
                  unit={t("个")}
                  tone="info"
                  hint={t("当前 DB 的 DBSIZE")}
                />
                <MetricCard
                  label={t("每秒操作数")}
                  testId="metric-qps"
                  value={int(info.instantaneous_ops_per_sec)}
                  unit="ops/s"
                  tone="info"
                  hint={t('累计处理 {{n}} 条命令', { n: int(info.total_commands_processed) })}
                />
                <MetricCard
                  label={t("已连接客户端")}
                  testId="metric-clients"
                  value={int(info.connected_clients)}
                  tone={num(info.blocked_clients) > 0 ? 'warning' : 'info'}
                  hint={t('阻塞 {{b}} · 拒绝 {{r}}', { b: info.blocked_clients, r: info.rejected_connections })}
                />
              </div>

              {/* ── QPS 趋势 ── */}
              <InfoCard
                title={t("每秒操作数趋势")}
                testId="trend-qps"
                icon={<IconBolt className="size-4 text-muted-foreground" />}
                action={<span className="text-[11px] text-muted-foreground">{t('{{n}} 个采样点', { n: qpsHistory.length })}</span>}
              >
                <div className="py-3">
                  <Sparkline points={qpsHistory} tone="info" height={64} testId="spark-qps" />
                </div>
                <p className="pb-2 text-[11px] text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey="<code>instantaneous_ops_per_sec</code> 是 Redis 自己的滑动窗口瞬时值，只在本次会话内累积成曲线。"
                    components={{ code: <code /> }}
                  />
                </p>
              </InfoCard>

              {/* ── 三张详情卡 ── */}
              <div className="grid grid-cols-1 gap-3 @3xl/main:grid-cols-3">
                <InfoCard
                  title={t("运行信息")}
                  testId="card-server"
                  icon={<IconServer className="size-4 text-muted-foreground" />}
                  action={<StatusPill tone="success">{t('已连接')}</StatusPill>}
                >
                  <InfoRow label={t("版本")} value={info.redis_version} />
                  <InfoRow label={t("运行模式")} value={info.redis_mode} />
                  <InfoRow label={t("节点角色")} value={info.role} />
                  <InfoRow label={t("监听端口")} value={info.tcp_port} />
                  <InfoRow label={t("运行时长")} value={formatDuration(info.uptime_seconds)} mono={false} />
                </InfoCard>

                <InfoCard
                  title={t("内存")}
                  testId="card-memory"
                  icon={<IconDatabase className="size-4 text-muted-foreground" />}
                >
                  <InfoRow label={t("已使用")} value={info.used_memory_human} />
                  <InfoRow label={t("RSS 常驻")} value={info.used_memory_rss_human} />
                  <InfoRow label={t("上限")} value={noLimit ? t('未限制') : info.maxmemory_human} />
                  <InfoRow label={t("碎片率")} value={frag.toFixed(2)} tone={fragMeta.tone} />
                  <div className="py-2 text-[11px] leading-snug text-muted-foreground">{fragMeta.text}</div>
                </InfoCard>

                <InfoCard
                  title={t("连接与吞吐")}
                  testId="card-clients"
                  icon={<IconNetwork className="size-4 text-muted-foreground" />}
                >
                  <InfoRow label={t("已连接客户端")} value={int(info.connected_clients)} />
                  <InfoRow
                    label={t("阻塞客户端")}
                    value={int(info.blocked_clients)}
                    tone={num(info.blocked_clients) > 0 ? 'warning' : undefined}
                  />
                  <InfoRow
                    label={t("拒绝的连接")}
                    value={int(info.rejected_connections)}
                    tone={num(info.rejected_connections) > 0 ? 'danger' : undefined}
                  />
                  <InfoRow label={t("命令处理总数")} value={int(info.total_commands_processed)} />
                  <InfoRow label={t("瞬时 QPS")} value={`${int(info.instantaneous_ops_per_sec)} ops/s`} />
                </InfoCard>
              </div>

              {/* ── 命令统计 ── */}
              <InfoCard
                title={t("命令统计")}
                testId="card-commands"
                icon={<IconChartBar className="size-4 text-muted-foreground" />}
                action={
                  <div className="flex items-center gap-2">
                    <TextFilter
                      value={search.cmd ?? ''}
                      placeholder={t("搜索命令…")}
                      testId="filter-cmd"
                      width="w-36"
                      onCommit={(v) => patch({ cmd: v || undefined })}
                    />
                    {commands.length > TOP_N && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        data-testid="toggle-all-cmds"
                        onClick={() => patch({ all: showAll ? undefined : 1 })}
                      >
                        {showAll ? t('只看前 {{n}}', { n: TOP_N }) : t('展开全部 {{n}} 条', { n: commands.length })}
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="flex items-center gap-4 border-b border-border/60 py-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <IconHash className="size-3.5" />
                    {t('{{n}} 种命令', { n: commands.length })}
                  </span>
                  <span>{t('累计调用 {{n}} 次', { n: formatNumber(totalCalls) })}</span>
                </div>
                <div className="py-3">
                  {visible.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground" data-testid="cmd-empty">
                      {search.cmd ? t('没有匹配的命令') : t('Redis 未开启 commandstats 或尚无调用')}
                    </p>
                  ) : (
                    <BarList items={visible} testId="cmd-bars" />
                  )}
                </div>
                <p className="pb-2 text-[11px] text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey="数据来自 <a>INFO commandstats</a>，是实例启动以来的累计值，<b>CONFIG RESETSTAT</b> 会清零。"
                    components={{ a: <code />, b: <code /> }}
                  />
                </p>
              </InfoCard>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
