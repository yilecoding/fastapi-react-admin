import * as React from 'react'
import { formatDateTime, formatDuration } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconCpu, IconDatabase, IconDeviceDesktop, IconServer2, IconBrandPython,
} from '@tabler/icons-react'

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'

import { PageHeader } from '../../shell/page-header'
import {
  DEFAULT_REFRESH, InfoCard, InfoRow, MetricCard, MonitorError,
  MonitorSkeleton, RefreshBar, Sparkline, UsageBar, usageTone, useSamples,
} from '../_shared/monitor'
import { StatusPill } from '../_shared/status'
import { parsePercent, serverKeys, serverMonitorQuery, type DiskInfo } from './api'

/**
 * 服务器监控。
 *
 * 硬纪律：组件 router-独立（search 走 props），视图状态（刷新间隔）进 URL。
 *
 * 采集是**后端进程所在机器**的指标 —— 本地开发时这就是宿主机，
 * 而数据库/Redis 在容器里，容器的资源不在这张页面上（那要另外接 exporter）。
 */
export type MonitorServerSearch = { refresh?: number }

const freq = (v: number) => (v > 0 ? `${v.toFixed(0)} MHz` : '—')

export function MonitorServerPage({
  search = {},
  onSearchChange,
}: {
  search?: MonitorServerSearch
  onSearchChange?: (n: MonitorServerSearch) => void
}) {
  const { t } = useTranslation()
  const refresh = search.refresh ?? DEFAULT_REFRESH
  const qc = useQueryClient()
  const { data, isPending, isFetching, error, dataUpdatedAt } = useQuery(serverMonitorQuery(refresh * 1000))

  const cpuHistory = useSamples(data?.cpu.usage, dataUpdatedAt)
  const memHistory = useSamples(data?.mem.usage, dataUpdatedAt)

  // 磁盘按使用率取最紧张的那块 —— 「磁盘使用率」这种单值指标必须是最坏情况，
  // 取平均会把一块 98% 的盘藏起来
  const worstDisk = React.useMemo(() => {
    if (!data?.disk.length) return null
    return data.disk.reduce<DiskInfo | null>(
      (worst, d) => (worst === null || parsePercent(d.usage) > parsePercent(worst.usage) ? d : worst),
      null
    )
  }, [data])

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader title={t("服务器监控")} description={t("后端进程所在主机的实时资源占用。数据由 psutil 现场采集，无历史留存。")}>
            <RefreshBar
              interval={refresh}
              updatedAt={dataUpdatedAt || undefined}
              fetching={isFetching}
              onIntervalChange={(v) => onSearchChange?.({ ...search, refresh: v })}
              onRefresh={() => void qc.invalidateQueries({ queryKey: serverKeys.all })}
            />
          </PageHeader>

          {error && <MonitorError error={error} />}
          {isPending && !error && <MonitorSkeleton />}

          {/* 内部 gap 用 gap-4 md:gap-6 —— 与外层页面容器同一个节奏。
              原来只写 gap-4，于是「页头 → 第一块」是 24px、
              「块与块之间」却是 16px，同一页两种间距 */}
          {data && (
            <div className="flex flex-col gap-4 md:gap-6" data-testid="server-monitor" data-fetching={isFetching}>
              {/* ── 四个顶层指标 ── */}
              <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @4xl/main:grid-cols-4">
                <MetricCard
                  label={t("CPU 使用率")}
                  testId="metric-cpu"
                  value={data.cpu.usage.toFixed(1)}
                  unit="%"
                  pct={data.cpu.usage}
                  hint={t('{{p}} 物理核 / {{l}} 逻辑核', { p: data.cpu.physical_num, l: data.cpu.logical_num })}
                />
                <MetricCard
                  label={t("内存使用率")}
                  testId="metric-mem"
                  value={data.mem.usage.toFixed(1)}
                  unit="%"
                  pct={data.mem.usage}
                  hint={`${data.mem.used.toFixed(2)} / ${data.mem.total.toFixed(2)} GB`}
                />
                <MetricCard
                  label={t("磁盘使用率")}
                  testId="metric-disk"
                  value={worstDisk ? parsePercent(worstDisk.usage).toFixed(1) : '—'}
                  unit={worstDisk ? '%' : undefined}
                  pct={worstDisk ? parsePercent(worstDisk.usage) : undefined}
                  hint={worstDisk ? t('最紧张：{{dir}}（{{free}} 可用）', { dir: worstDisk.dir, free: worstDisk.free }) : t('无可读分区')}
                />
                <MetricCard
                  label={t("服务运行时长")}
                  testId="metric-elapsed"
                  value={<span className="text-xl">{formatDuration(data.service.elapsed_seconds)}</span>}
                  tone="info"
                  hint={t('启动于 {{at}}', { at: formatDateTime(data.service.startup) })}
                />
              </div>

              {/* ── 趋势线（本次会话内采样） ──
                  说明文字要贴着它解释的那两张卡，所以**包一层 gap-2 的分组**，
                  而不是给说明加 `-mt-2` 把它拽上去 —— 负 margin 会让
                  「说明上方 8px、下方 24px」，同一条缝两个数 */}
              <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 gap-3 @2xl/main:grid-cols-2">
                <InfoCard
                  title={t("CPU 使用率趋势")}
                  testId="trend-cpu"
                  icon={<IconCpu className="size-4 text-muted-foreground" />}
                  action={<span className="text-[11px] text-muted-foreground">{t('{{n}} 个采样点', { n: cpuHistory.length })}</span>}
                >
                  <div className="py-3">
                    <Sparkline points={cpuHistory} max={100} tone={usageTone(data.cpu.usage)} testId="spark-cpu" />
                  </div>
                </InfoCard>
                <InfoCard
                  title={t("内存使用率趋势")}
                  testId="trend-mem"
                  icon={<IconDatabase className="size-4 text-muted-foreground" />}
                  action={<span className="text-[11px] text-muted-foreground">{t('{{n}} 个采样点', { n: memHistory.length })}</span>}
                >
                  <div className="py-3">
                    <Sparkline points={memHistory} max={100} tone={usageTone(data.mem.usage)} testId="spark-mem" />
                  </div>
                </InfoCard>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('趋势只统计本次会话内的采样 —— 页面刷新即清零；切到别的页签期间不采样（隐藏页签的定时器会被停掉）。')}
              </p>
              </div>

              {/* ── 三张详情卡 ── */}
              <div className="grid grid-cols-1 gap-3 @3xl/main:grid-cols-3">
                <InfoCard title="CPU" testId="card-cpu" icon={<IconCpu className="size-4 text-muted-foreground" />}>
                  <InfoRow label={t("物理核心数")} value={data.cpu.physical_num} />
                  <InfoRow label={t("逻辑核心数")} value={data.cpu.logical_num} />
                  <InfoRow label={t("当前频率")} value={freq(data.cpu.current_freq)} />
                  <InfoRow label={t("最大频率")} value={freq(data.cpu.max_freq)} />
                  <InfoRow label={t("最小频率")} value={freq(data.cpu.min_freq)} />
                  <InfoRow label={t("使用率")} value={`${data.cpu.usage.toFixed(1)}%`} tone={usageTone(data.cpu.usage)} />
                </InfoCard>

                <InfoCard title={t("内存")} testId="card-mem" icon={<IconDatabase className="size-4 text-muted-foreground" />}>
                  <InfoRow label={t("总容量")} value={`${data.mem.total.toFixed(2)} GB`} />
                  <InfoRow label={t("已使用")} value={`${data.mem.used.toFixed(2)} GB`} />
                  <InfoRow label={t("可用")} value={`${data.mem.free.toFixed(2)} GB`} />
                  <InfoRow label={t("使用率")} value={`${data.mem.usage.toFixed(1)}%`} tone={usageTone(data.mem.usage)} />
                  <div className="py-2">
                    <UsageBar pct={data.mem.usage} />
                  </div>
                </InfoCard>

                <InfoCard
                  title={t("系统")}
                  testId="card-sys"
                  icon={<IconDeviceDesktop className="size-4 text-muted-foreground" />}
                >
                  <InfoRow label={t("主机名")} value={data.sys.name} title={data.sys.name} />
                  <InfoRow label={t("操作系统")} value={data.sys.os} />
                  <InfoRow label={t("系统架构")} value={data.sys.arch} />
                  <InfoRow label={t("IP 地址")} value={data.sys.ip} />
                  <InfoRow label={t("分区数")} value={data.disk.length} />
                </InfoCard>
              </div>

              {/* ── Python 服务进程 ── */}
              <InfoCard
                title={t("服务进程")}
                testId="card-service"
                icon={<IconBrandPython className="size-4 text-muted-foreground" />}
                action={<StatusPill tone="success">{t('运行中')}</StatusPill>}
              >
                <div className="grid grid-cols-1 gap-x-8 @2xl/main:grid-cols-2 @4xl/main:grid-cols-3">
                  <InfoRow label={t("名称")} value={`${data.service.name} ${data.service.version}`} />
                  <InfoRow label={t("启动时间")} value={formatDateTime(data.service.startup)} />
                  <InfoRow label={t("运行时长")} value={formatDuration(data.service.elapsed_seconds)} />
                  <InfoRow label={t("进程 CPU")} value={data.service.cpu_usage} />
                  <InfoRow label={t("物理内存 RSS")} value={data.service.mem_rss} />
                  <InfoRow label={t("虚拟内存 VMS")} value={data.service.mem_vms} />
                </div>
                <InfoRow label={t("解释器路径")} value={data.service.home} title={data.service.home} />
              </InfoCard>

              {/* ── 磁盘 ── */}
              <InfoCard
                title={t("磁盘分区")}
                testId="card-disk"
                icon={<IconServer2 className="size-4 text-muted-foreground" />}
                action={<span className="text-[11px] text-muted-foreground">{t('已排除 overlay / tmpfs 等虚拟文件系统')}</span>}
              >
                {/* overflow-x-auto 而不是 hidden：窄屏下最右列不能被裁掉 */}
                <div className="overflow-x-auto py-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('挂载点')}</TableHead>
                        <TableHead>{t('设备')}</TableHead>
                        <TableHead>{t('文件系统')}</TableHead>
                        <TableHead className="text-right">{t('总容量')}</TableHead>
                        <TableHead className="text-right">{t('已使用')}</TableHead>
                        <TableHead className="text-right">{t('可用')}</TableHead>
                        <TableHead className="w-48">{t('使用率')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.disk.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="h-16 text-center text-sm text-muted-foreground">
                            {t('没有可读取的分区')}
                          </TableCell>
                        </TableRow>
                      )}
                      {data.disk.map((d) => {
                        const pct = parsePercent(d.usage)
                        return (
                          <TableRow key={`${d.device}-${d.dir}`} data-testid={`disk-${d.dir}`}>
                            <TableCell className="font-mono text-xs">{d.dir}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{d.device}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{d.type}</TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">{d.total}</TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">{d.used}</TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">{d.free}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <UsageBar pct={pct} />
                                <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                                  {d.usage}
                                </span>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </InfoCard>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
