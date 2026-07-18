import { createColumnHelper } from '@tanstack/react-table'
import { IconDotsVertical, IconLogout, IconWifi, IconWifiOff } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { buildSelectColumn } from '../_shared/select-column'
import { StatusPill } from '../_shared/status'
import { remainingText, type OnlineSession } from './api'
import type { features } from './table-features'

const col = createColumnHelper<typeof features, OnlineSession>()

export function buildColumns({
  page,
  size,
  now,
  currentUuid,
  onKick,
  t,
}: {
  page: number
  size: number
  /** 「剩余有效期」要的当前时刻。由页面每次取数时刷新，不在 cell 里读 Date.now() */
  now: number
  currentUuid: string | null
  onKick: (s: OnlineSession) => void
  /** 从组件传进来 —— 这是**普通函数**（在 useMemo 里被调用），自己调 hook 会违反 Hooks 规则 */
  t: (k: string, vars?: Record<string, unknown>) => string
}) {
  return [
    // 当前会话不给勾 —— 批量下线里混进自己，点完就被踢回登录页
    buildSelectColumn(col, { canSelect: (s: OnlineSession) => s.session_uuid !== currentUuid }, t),
    col.display({
      id: 'seq',
      header: t('序号'),
      cell: ({ row }) => (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {(page - 1) * size + row.index + 1}
        </span>
      ),
    }),
    col.accessor('username', {
      header: t('用户'),
      cell: ({ row }) => {
        const s = row.original
        const isMe = s.session_uuid === currentUuid
        return (
          <div className="flex flex-col">
            <span className="flex items-center gap-1.5 text-sm font-medium leading-tight">
              {s.nickname || s.username}
              {isMe && (
                <Badge variant="outline" className="font-normal" data-testid="current-session-badge">
                  {t('当前会话')}
                </Badge>
              )}
            </span>
            <span className="text-xs leading-tight text-muted-foreground">{s.username}</span>
          </div>
        )
      },
    }),
    col.accessor('status', {
      header: t('实时连接'),
      cell: ({ getValue }) => {
        const online = getValue() === 1
        return (
          <StatusPill
            tone={online ? 'success' : 'muted'}
            className="gap-1"
            title={online ? t('该会话有活跃的 WebSocket 连接') : t('仅 token 有效，页面未打开或已关闭')}
          >
            {online ? <IconWifi className="size-3" /> : <IconWifiOff className="size-3" />}
            {online ? t('在线') : t('离线')}
          </StatusPill>
        )
      },
    }),
    col.accessor('ip', {
      header: t('登录 IP'),
      cell: ({ getValue }) => <span className="font-mono text-xs tabular-nums">{getValue()}</span>,
    }),
    col.accessor('browser', {
      header: t('浏览器'),
      cell: ({ getValue }) => (
        <span className="block max-w-40 truncate text-sm text-muted-foreground" title={getValue()}>
          {getValue()}
        </span>
      ),
    }),
    col.accessor('os', {
      header: t('终端系统'),
      cell: ({ row, getValue }) => (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {getValue()}
          {row.original.device && row.original.device !== '未知' && (
            <Badge variant="outline" className="font-normal">{row.original.device}</Badge>
          )}
        </span>
      ),
    }),
    col.accessor('last_login_time', {
      header: t('登录时间'),
      cell: ({ getValue }) => (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{getValue()}</span>
      ),
    }),
    col.accessor((s) => s.expire_time, {
      id: 'expire',
      header: t('剩余有效期'),
      cell: ({ row }) => {
        const { text, hours } = remainingText(row.original.expire_time, now)
        return (
          <span
            title={t('过期于 {{at}}', { at: row.original.expire_time })}
            className={cn(
              'font-mono text-xs tabular-nums',
              hours <= 0 ? 'text-destructive' : hours < 2 ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'
            )}
          >
            {text}
          </span>
        )
      },
    }),
    col.accessor('session_uuid', {
      header: t('会话 UUID'),
      cell: ({ getValue }) => (
        <span className="font-mono text-[11px] text-muted-foreground" title={getValue()}>
          {getValue().slice(0, 8)}…
        </span>
      ),
    }),
    col.display({
      id: 'actions',
      enableHiding: false,
      header: () => <span className="sr-only">{t('操作')}</span>,
      cell: ({ row }) => {
        const s = row.original
        const isMe = s.session_uuid === currentUuid
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: s.username })} />}
              data-testid={`row-actions-${s.session_uuid}`}
            >
              <IconDotsVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                variant="destructive"
                disabled={isMe}
                onClick={() => onKick(s)}
                data-testid={`kick-${s.session_uuid}`}
              >
                <IconLogout className="size-4" />
                {isMe ? t('不能踢自己') : t('强制下线')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    }),
  ]
}

export const COLUMN_LABELS: Record<string, string> = {
  seq: '序号',
  username: '用户',
  status: '实时连接',
  ip: '登录 IP',
  browser: '浏览器',
  os: '终端系统',
  last_login_time: '登录时间',
  expire: '剩余有效期',
  session_uuid: '会话 UUID',
}
