import { createColumnHelper } from '@tanstack/react-table'
import { IconDotsVertical, IconEye } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'

import { logFeatures } from '../_shared/log-features'
import type { InstanceRow } from '../workflow/api'
import { InstanceStatusPill } from '../workflow/status'
import { PersonAvatar, UrgentTag } from '../workflow/track'

const col = createColumnHelper<typeof logFeatures, InstanceRow>()

const dash = <span className="text-muted-foreground">—</span>

/**
 * 实例监控的列。和用户管理页同一套写法（`user/columns.tsx`）：首列是主体（标题 + 摘要），
 * 最后一列是行操作（⋮）。没有勾选列 —— 这一页没有批量动作。
 */
export function buildColumns(onOpen: (r: InstanceRow) => void, t: (k: string, vars?: Record<string, unknown>) => string) {
  return [
    col.accessor('title', {
      header: t('审批'),
      cell: ({ row }) => {
        const r = row.original
        return (
          <div className="flex min-w-0 max-w-96 flex-col">
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                className="truncate text-start text-sm font-medium leading-tight hover:text-primary hover:underline"
                onClick={() => onOpen(r)}
                data-testid={`wf-monitor-open-${r.id}`}
              >
                {r.title}
              </button>
              {r.urgent && <UrgentTag />}
            </span>
            {r.summary && <span className="truncate text-xs leading-tight text-muted-foreground">{r.summary}</span>}
          </div>
        )
      },
    }),
    col.accessor('definition_name', {
      id: 'definition',
      header: t('流程'),
      cell: ({ getValue }) => <span className="text-sm">{getValue() || dash}</span>,
    }),
    col.accessor('initiator_name', {
      id: 'initiator',
      header: t('发起人'),
      cell: ({ getValue }) => (
        <span className="flex items-center gap-2 text-sm">
          <PersonAvatar name={getValue() ?? ''} />
          {getValue() ?? dash}
        </span>
      ),
    }),
    // 监控最常问的一句「卡在谁手上」：只有在办的单子有
    col.accessor((r) => r.current_node_name ?? '', {
      id: 'current',
      header: t('当前处理'),
      cell: ({ row }) => {
        const r = row.original
        if (r.status !== 'running' || !r.current_node_name) return dash
        return (
          <div className="flex min-w-0 flex-col">
            <span className="text-sm leading-tight">{r.current_node_name}</span>
            <span className="truncate text-xs leading-tight text-muted-foreground">{(r.handlers ?? []).join('、') || '—'}</span>
          </div>
        )
      },
    }),
    col.accessor('status', {
      header: t('状态'),
      cell: ({ getValue }) => <InstanceStatusPill status={getValue()} />,
    }),
    col.accessor('created_time', {
      header: t('发起时间'),
      cell: ({ getValue }) => <span className="text-sm tabular-nums text-muted-foreground">{formatDateTime(getValue())}</span>,
    }),
    col.accessor('finished_time', {
      header: t('结束时间'),
      cell: ({ getValue }) => <span className="text-sm tabular-nums text-muted-foreground">{formatDateTime(getValue())}</span>,
    }),
    col.display({
      id: 'actions',
      header: () => <span className="sr-only">{t('操作')}</span>,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: row.original.title })} />}
            data-testid={`wf-monitor-actions-${row.original.id}`}
          >
            <IconDotsVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            {/* 终止 / 改办理人在详情里（按能力信封出），这里只给入口 */}
            <DropdownMenuItem onClick={() => onOpen(row.original)}>
              <IconEye className="size-4" />
              {t('查看详情')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    }),
  ]
}

export const COLUMN_LABELS: Record<string, string> = {
  title: '审批',
  definition: '流程',
  initiator: '发起人',
  current: '当前处理',
  status: '状态',
  created_time: '发起时间',
  finished_time: '结束时间',
}
