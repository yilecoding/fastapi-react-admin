import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconFiles } from '@tabler/icons-react'

import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import {
  FILE_TYPE_LABEL,
  fileStatisticsQuery,
  formatBytes,
  type FileType,
} from './api'
import { TYPE_TONE, fileIconOf } from './file-icon'

/** 左栏的分类顺序。写死而不是从 statistics 的 key 生成 —— 那样顺序跟着后端返回走 */
const RAIL_TYPES: FileType[] = ['image', 'document', 'video', 'audio', 'archive', 'other']

/** 占比条的配色，和图标着色同源 */
const TYPE_BAR: Record<FileType, string> = {
  image: 'bg-violet-500',
  document: 'bg-sky-500',
  video: 'bg-rose-500',
  audio: 'bg-amber-500',
  archive: 'bg-orange-500',
  other: 'bg-muted-foreground',
}

/**
 * 左栏：分类导航 + 存储统计。
 *
 * 统计走 `/sys/files/statistics`（库里 GROUP BY），所以「全部 / 各分类」的数量
 * 是**全量**的，不受当前筛选影响 —— 这正是它的用处：先看总体分布，再钻进去。
 *
 * 占比用**纯 CSS 的横向堆叠条**，不引图表库：
 * 饼图要测容器宽度，而隐藏 tab 是 `display:none`（宽度 0），
 * 监控页的趋势线已经因为同一个原因换掉了 recharts。
 */
export function FileRail({
  value,
  onChange,
  className,
}: {
  value: FileType | undefined
  onChange: (next: FileType | undefined) => void
  className?: string
}) {
  const { t } = useTranslation()
  const { data, isPending } = useQuery(fileStatisticsQuery())

  const total = data?.total_count ?? 0
  const totalSize = data?.total_size ?? 0

  return (
    <aside className={cn('flex flex-col gap-4', className)} data-testid="file-rail">
      <nav className="flex flex-col gap-0.5">
        <RailItem
          icon={<IconFiles className="size-4 text-muted-foreground" aria-hidden />}
          label={t('全部')}
          count={total}
          active={value === undefined}
          loading={isPending}
          testId="rail-all"
          onClick={() => onChange(undefined)}
        />
        {RAIL_TYPES.map((type) => {
          const Icon = fileIconOf({ ext: '', type })
          return (
            <RailItem
              key={type}
              icon={<Icon className={cn('size-4', TYPE_TONE[type])} aria-hidden />}
              label={t(FILE_TYPE_LABEL[type])}
              count={data?.type_counts?.[type] ?? 0}
              active={value === type}
              loading={isPending}
              testId={`rail-${type}`}
              onClick={() => onChange(type)}
            />
          )
        })}
      </nav>

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t('已用空间')}</span>
          {isPending ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            <span className="text-sm font-medium tabular-nums" data-testid="rail-total-size">
              {formatBytes(totalSize)}
            </span>
          )}
        </div>

        {/* 堆叠占比条。总量为 0 时不渲染 —— 一条空灰槽传达不了任何信息 */}
        {totalSize > 0 && (
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" data-testid="rail-bar">
            {RAIL_TYPES.map((type) => {
              const size = data?.type_sizes?.[type] ?? 0
              if (size === 0) return null
              return (
                <span
                  key={type}
                  className={TYPE_BAR[type]}
                  style={{ width: `${(size / totalSize) * 100}%` }}
                  title={`${t(FILE_TYPE_LABEL[type])} ${formatBytes(size)}`}
                />
              )
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t('共 {{n}} 个文件', { n: total })}
        </p>
      </div>
    </aside>
  )
}

function RailItem({
  icon,
  label,
  count,
  active,
  loading,
  testId,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  loading: boolean
  testId: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active}
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-sm transition',
        active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {loading ? (
        <Skeleton className="h-4 w-6" />
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  )
}
