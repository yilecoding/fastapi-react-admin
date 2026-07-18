import { queryOptions } from '@tanstack/react-query'

import { api } from '../../api-client/client'

/**
 * 服务器监控。数据源 `GET /api/v1/monitors/server`（**仅超管**，
 * 后端 `DependsSuperUser`），由 psutil 在线程池里现场采集，没有历史表。
 *
 * 所以「趋势」只能是前端在本次会话里累积的采样（见 `_shared/monitor.tsx: useSamples`）。
 * 要真正的历史曲线得上时序库，那是另一个量级的活。
 */
export type CpuInfo = {
  physical_num: number
  logical_num: number
  /** WSL2 / 容器里 psutil 拿不到主频，会是 0 —— 页面要显示 '—' 而不是 "0 MHz" */
  max_freq: number
  min_freq: number
  current_freq: number
  usage: number
}

export type MemInfo = {
  /** 单位 GB */
  total: number
  used: number
  free: number
  usage: number
}

export type SysInfo = { name: string; os: string; ip: string; arch: string }

/** 后端已把字节格式化成 "1006.85 GB"，usage 是 "5.20%" 这样的字符串 */
export type DiskInfo = {
  dir: string
  device: string
  type: string
  total: string
  used: string
  free: string
  usage: string
}

export type ServiceInfo = {
  name: string
  version: string
  home: string
  startup: string
  /** 运行时长（秒）—— 成句交给 formatDuration，后端不再拼中文 */
  elapsed_seconds: number
  cpu_usage: string
  mem_vms: string
  mem_rss: string
  mem_free: string
}

export type ServerMonitor = {
  cpu: CpuInfo
  mem: MemInfo
  sys: SysInfo
  disk: DiskInfo[]
  service: ServiceInfo
}

export const serverKeys = { all: ['monitor', 'server'] as const }

/**
 * `refreshMs` **不进 queryKey** —— 改刷新节奏不该让缓存作废、表格闪空。
 * `refetchIntervalInBackground: false`：浏览器标签页切走就停，别在后台空转。
 */
export const serverMonitorQuery = (refreshMs: number) =>
  queryOptions({
    queryKey: serverKeys.all,
    queryFn: () => api.GET<ServerMonitor>('/api/v1/monitors/server'),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: false,
  })

/** "5.20%" → 5.2；解析不出来给 NaN，配色会落到 muted */
export function parsePercent(v: string): number {
  return Number.parseFloat(v.replace('%', ''))
}
