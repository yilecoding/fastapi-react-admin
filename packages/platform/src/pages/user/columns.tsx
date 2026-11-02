import { createColumnHelper } from '@tanstack/react-table'
import { IconPencil, IconShieldLock, IconTrash } from '@tabler/icons-react'

import { ACTIONS_COLUMN_ID } from '@admin/ui/components/data-table'
import { Avatar, AvatarFallback, AvatarImage } from '@admin/ui/components/avatar'
import { Badge } from '@admin/ui/components/badge'

import { RowActions, TimeCell } from '../_shared/cells'
import { buildSelectColumn } from '../_shared/select-column'
import { StatusBadge } from '../_shared/status'
import type { User } from './api'
import type { features } from './table-features'

const col = createColumnHelper<typeof features, User>()

export function buildColumns(
  onEdit: (u: User) => void,
  onDelete: (u: User) => void,
  onSecurity: (u: User) => void,
  /** 普通函数不能自己调 hook —— 由组件传进来 */
  t: (k: string, vars?: Record<string, unknown>) => string
) {
  return [
    // 超管不可删 —— 那一行也不给勾，免得批量删除里凑进一条注定失败的
    buildSelectColumn(col, { canSelect: (u: User) => !u.is_superuser }, t),
    col.accessor('username', {
      header: t('用户'),
      cell: ({ row }) => {
        const u = row.original
        return (
          <div className="flex items-center gap-2">
            <Avatar className="size-7">
              {u.avatar && <AvatarImage src={u.avatar} alt="" />}
              <AvatarFallback className="text-xs">{u.nickname?.slice(0, 1) ?? u.username.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col">
              <span className="text-sm font-medium leading-tight">{u.nickname || u.username}</span>
              <span className="text-xs leading-tight text-muted-foreground">{u.username}</span>
            </div>
          </div>
        )
      },
    }),
    col.accessor('email', {
      header: t('邮箱'),
      cell: ({ getValue }) => <span className="text-sm">{getValue() || <span className="text-muted-foreground">—</span>}</span>,
    }),
    col.accessor('phone', {
      header: t('手机号'),
      cell: ({ getValue }) => <span className="text-sm tabular-nums">{getValue() || <span className="text-muted-foreground">—</span>}</span>,
    }),
    col.accessor((r) => r.dept?.name ?? '', {
      id: 'dept',
      header: t('部门'),
      cell: ({ getValue }) => <span className="text-sm">{getValue() || <span className="text-muted-foreground">—</span>}</span>,
    }),
    col.accessor('roles', {
      header: t('角色'),
      cell: ({ getValue }) => {
        const roles = getValue()
        if (!roles?.length) return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {roles.map((r) => (
              <Badge key={r.id} variant="outline" className="font-normal">{r.name}</Badge>
            ))}
          </div>
        )
      },
    }),
    col.accessor('status', {
      header: t('状态'),
      cell: ({ getValue, row }) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge value={getValue()} />
          {row.original.is_superuser && (
            <Badge variant="secondary" className="font-normal">{t('超管')}</Badge>
          )}
        </div>
      ),
    }),
    col.accessor('join_time', {
      header: t('注册时间'),
      cell: ({ getValue }) => (
        <TimeCell value={getValue()} />
      ),
    }),
    col.display({
      id: ACTIONS_COLUMN_ID,
      header: () => <span className="sr-only">{t('操作')}</span>,
      cell: ({ row }) => {
        const u = row.original
        return (
          <RowActions
            label={u.username}
            testId={`row-actions-${u.username}`}
            items={[
              // 编辑、权限与安全后端都是 DependsSuperUser（user.py:71,80），不是权限码校验 ——
              // 按超管直判，别编一个假权限码
              { key: 'edit', label: t('编辑'), icon: IconPencil, superOnly: true, testId: `edit-${u.username}`, onClick: () => onEdit(u) },
              {
                key: 'security', label: t('权限与安全'), icon: IconShieldLock, superOnly: true,
                testId: `security-${u.username}`, onClick: () => onSecurity(u),
              },
              {
                key: 'del', label: t('删除'), icon: IconTrash, perm: 'sys:user:del', danger: true,
                disabled: u.is_superuser, testId: `delete-${u.username}`, onClick: () => onDelete(u),
              },
            ]}
          />
        )
      },
    }),
  ]
}

export const COLUMN_LABELS: Record<string, string> = {
  username: '用户',
  email: '邮箱',
  phone: '手机号',
  dept: '部门',
  roles: '角色',
  status: '状态',
  join_time: '注册时间',
}
