import { queryOptions } from '@tanstack/react-query'
import { formatNumber, t } from '@admin/i18n'

import { api } from '../../api-client/client'

/**
 * Redis 监控。数据源 `GET /api/v1/monitors/redis`（登录即可，非超管专属）。
 *
 * 后端把 `INFO` 的结果**全部转成字符串**下发（见 `schema/monitor.py`），
 * 所以这里的数字要自己 parse。不要嫌麻烦直接当字符串显示 —— 阈值配色需要数值。
 */
export type RedisServerInfo = {
  redis_version: string
  redis_mode: string
  role: string
  tcp_port: string
  /** 运行时长（秒）—— 同上 */
  uptime_seconds: number
  connected_clients: string
  blocked_clients: string
  used_memory_human: string
  used_memory_rss_human: string
  /** '0B' 表示没设 maxmemory —— 页面显示「未限制」 */
  maxmemory_human: string
  mem_fragmentation_ratio: string
  instantaneous_ops_per_sec: string
  total_commands_processed: string
  rejected_connections: string
  keys_num: string
}

export type RedisCommandStat = { name: string; value: string }

export type RedisMonitor = { info: RedisServerInfo; stats: RedisCommandStat[] }

export const redisKeys = { all: ['monitor', 'redis'] as const }

export const redisMonitorQuery = (refreshMs: number) =>
  queryOptions({
    queryKey: redisKeys.all,
    queryFn: () => api.GET<RedisMonitor>('/api/v1/monitors/redis'),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: false,
  })

export const num = (v: string | undefined): number => {
  const n = Number.parseFloat(v ?? '')
  return Number.isFinite(n) ? n : 0
}

/** 千分位。命令调用次数动辄六位数，不分节根本读不出量级 */
export const int = (v: string | undefined): string => formatNumber(num(v))

/**
 * 内存碎片率的解读（`used_memory_rss / used_memory`）：
 *   < 1    → RSS 小于逻辑内存，说明有数据被换到 swap，**最危险**
 *   1 ~ 1.5 → 正常
 *   > 1.5  → 碎片偏高，考虑重启或开 activedefrag
 * 数据集很小时（本地开发几百个 key）这个比值天然虚高，不必当真。
 */
export function fragmentationHint(ratio: number): { tone: 'success' | 'warning' | 'danger'; text: string } {
  if (ratio > 0 && ratio < 1) return { tone: 'danger', text: t('低于 1，可能有数据被换到 swap') }
  if (ratio > 1.5) return { tone: 'warning', text: t('高于 1.5，碎片偏高（小数据集下属正常）') }
  return { tone: 'success', text: t('在 1 ~ 1.5 的正常区间') }
}
