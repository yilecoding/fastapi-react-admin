import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  IconChevronLeft, IconChevronRight, IconInfoCircle, IconUserMinus, IconUserPlus,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { DataTableSkeletonRows } from '@admin/ui/components/data-table'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'

import { Can } from '../../auth/can'
import { usePerm } from '../../auth/use-perm'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { StatusBadge } from '../_shared/status'
import { roleUsersQuery, useRemoveRoleUsers, userRolesQuery, type Role } from './api'
import { UserPicker } from './user-picker'
import type { User } from '../user/api'

const SIZE = 10

/**
 * 角色下的用户，可增可减。
 *
 * 增删只动 `user_role` 一行关联（`POST/DELETE /roles/{id}/users`），
 * 不碰用户对象本身 —— 一个用户可以同时有多个角色，从这里移出他只是少一个角色，
 * 不是把他从系统里删掉。
 */
export function RoleUsers({
  role,
  page,
  onPage,
}: {
  role: Role
  page: number
  onPage: (p: number) => void
}) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const editable = can('sys:role:edit')

  const { data, isPending, isFetching } = useQuery(
    roleUsersQuery({ role: role.id, page, size: SIZE })
  )

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, data?.total_pages ?? 1)

  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [pendingRemove, setPendingRemove] = React.useState<User[] | null>(null)
  const remove = useRemoveRoleUsers()

  // 换页/换角色后留着的选中项已经不在可见行里，必须清掉
  React.useEffect(() => setPicked(new Set()), [page, role.id])

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const pickedOnPage = rows.filter((u) => picked.has(u.id))
  const allChecked = rows.length > 0 && pickedOnPage.length === rows.length

  return (
    <div className="flex flex-col gap-3 content-scroll:lg:min-h-0 content-scroll:lg:flex-1" data-testid="role-users">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Can perm="sys:role:edit">
          <Button size="sm" onClick={() => setPickerOpen(true)} data-testid="role-users-add">
            <IconUserPlus className="size-4" />{t('添加用户')}
          </Button>
          {pickedOnPage.length > 0 && (
            <Button
              variant="outline" size="sm"
              className="h-8 text-destructive hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => setPendingRemove(pickedOnPage)}
              data-testid="role-users-bulk-remove"
            >
              <IconUserMinus className="size-4" />{t('移出 {{n}} 人', { n: pickedOnPage.length })}
            </Button>
          )}
        </Can>
        <span className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="role-users-hint">
          <IconInfoCircle className="mt-px size-3.5 shrink-0" />
          {/* 整句一条 key：前半以「，」结尾的碎 key 换成英文语序就散架 */}
          {t('共 {{n}} 人持有「{{role}}」，改这个角色的权限会同时影响他们全部。', {
            n: total,
            role: role.name,
          })}
        </span>
      </div>

      <div
        className="overflow-x-auto rounded-lg border content-scroll:lg:flex content-scroll:lg:min-h-0 content-scroll:lg:flex-1 content-scroll:lg:flex-col"
        data-testid="role-users-table"
        aria-busy={isFetching}
      >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted shadow-[inset_0_-1px_0_var(--border)]">
            <TableRow>
              {editable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allChecked}
                    indeterminate={pickedOnPage.length > 0 && !allChecked}
                    disabled={rows.length === 0}
                    onCheckedChange={() =>
                      setPicked(allChecked ? new Set() : new Set(rows.map((u) => u.id)))
                    }
                    data-testid="role-users-check-all"
                    aria-label={t("全选本页用户")}
                  />
                </TableHead>
              )}
              <TableHead>{t('用户名')}</TableHead>
              <TableHead>{t('昵称')}</TableHead>
              <TableHead>{t('部门')}</TableHead>
              <TableHead>{t('状态')}</TableHead>
              <TableHead>{t('最后登录')}</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <DataTableSkeletonRows rows={5} columns={editable ? 7 : 6} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={editable ? 7 : 6} className="h-24 text-center text-muted-foreground">
                  {t('还没有用户持有这个角色')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((u) => (
                  <TableRow key={u.id} data-testid={`role-user-${u.username}`}>
                    {editable && (
                      <TableCell>
                        <Checkbox
                          checked={picked.has(u.id)}
                          onCheckedChange={() => toggle(u.id)}
                          data-testid={`role-user-check-${u.username}`}
                          aria-label={t('选择 {{name}}', { name: u.username })}
                        />
                      </TableCell>
                    )}
                    <TableCell className="text-sm font-medium">{u.username}</TableCell>
                    <TableCell className="text-sm">{u.nickname || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.dept?.name ?? '—'}</TableCell>
                    <TableCell><StatusBadge value={u.status} /></TableCell>
                    <TableCell className="text-sm tabular-nums text-muted-foreground">
                      {u.last_login_time ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Can perm="sys:role:edit">
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 text-destructive hover:text-destructive"
                          disabled={remove.isPending}
                          onClick={() => setPendingRemove([u])}
                          data-testid={`role-user-remove-${u.username}`}
                        >
                          {t('移出')}
                        </Button>
                      </Can>
                    </TableCell>
                  </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground">
          <Button variant="ghost" size="icon" className="size-6" aria-label={t("上一页")}
                  disabled={page <= 1} onClick={() => onPage(page - 1)} data-testid="role-users-prev">
            <IconChevronLeft className="size-3.5" />
          </Button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="size-6" aria-label={t("下一页")}
                  disabled={page >= totalPages} onClick={() => onPage(page + 1)} data-testid="role-users-next">
            <IconChevronRight className="size-3.5" />
          </Button>
        </div>
      )}

      <UserPicker open={pickerOpen} onOpenChange={setPickerOpen} role={role} />

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        title={t("移出角色")}
        description={<RemoveHint users={pendingRemove} roleId={role.id} roleName={role.name} />}
        confirmText={t("移出")}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (!pendingRemove) return
          await remove.mutateAsync({ id: role.id, users: pendingRemove.map((u) => u.id) })
          setPicked(new Set())
          setPendingRemove(null)
        }}
      />
    </div>
  )
}

/**
 * 移出后会一个角色都不剩的人要单独点名 —— 那等于把他挡在系统门外。
 *
 * 用户的完整角色不能从列表数据里读：`?role=` 过滤会把 `roles` 截成只剩当前角色，
 * 那样判断出来的结果是「所有人都会变成裸角色」，永远误报。这里对每个待移出的人
 * 单独查一次 `/users/{pk}/roles`，只在确认框打开时发生。
 */
function RemoveHint({ users, roleId, roleName }: { users: User[] | null; roleId: string; roleName: string }) {
  const { t } = useTranslation()
  const list = users ?? []
  const results = useQueries({
    queries: list.map((u) => ({ ...userRolesQuery(u.id), staleTime: 0 })),
  })

  const loading = results.some((r) => r.isPending)
  const naked = list.filter((_u, i) => {
    const owned = results[i]?.data
    return owned ? owned.filter((r) => r.id !== roleId).length === 0 : false
  })

  /**
   * 单人 / 多人各一条**整句** key。
   *
   * 原先是「`把 {{who}} 移出…`」+ 把 who 拼成 `` `「${username}」` `` ——
   * 那个片段既没进语言包（`「」` 不在 check.mjs 的中文区间里，missing-keys 抓不到），
   * 英文界面下还会渲染出中文书名号。整句进包，语序也能跟着英文调。
   */
  return (
    <>
      {list.length === 1
        ? t('把「{{name}}」移出角色「{{role}}」？用户本身不会被删除，其它角色也保留。', {
            name: list[0]!.username,
            role: roleName,
          })
        : t('把选中的 {{n}} 个用户移出角色「{{role}}」？用户本身不会被删除，其它角色也保留。', {
            n: list.length,
            role: roleName,
          })}
      {loading && (
        <span className="mt-2 block text-muted-foreground">{t('正在确认他们还剩哪些角色…')}</span>
      )}
      {!loading && naked.length > 0 && (
        <span className="mt-2 block text-amber-700 dark:text-amber-300" data-testid="remove-naked-warn">
          {t('注意：{{names}} 移出后就没有任何角色了，将看不到任何菜单（超级管理员除外）。', {
            names: naked.map((u) => u.username).join('、'),
          })}
        </span>
      )}
    </>
  )
}
