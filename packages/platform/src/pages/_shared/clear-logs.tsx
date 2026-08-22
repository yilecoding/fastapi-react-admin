import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconTrash } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { api } from '../../api-client/client'
import { ApiError } from '../../api-client/errors'
import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'

/**
 * 「清空日志」入口。登录日志和操作日志共用。
 *
 * 为什么需要它：日志表是**只增不减**的（两个页面都是只读列表，没有行选择也就没有
 * 批量删除），而 `sys_login_log` / `sys_opera_log` 会随时间无限增长 ——
 * 在这之前界面上**没有任何清理入口**，只能去数据库里手动 truncate。
 * 菜单种子里 `log:*:clear` 这个权限码一直存在，只是没人用。
 *
 * ⚠️ 这是不可逆的全表删除，**不受当前筛选条件影响** —— 后端
 * `DELETE /logs/{kind}/all` 是 `delete_all()`，不带任何 where。
 * 确认框里必须把这两点都说清楚：删的是全部，不是你现在筛出来的这些。
 */
export function ClearLogsButton({
  kind,
  filtered,
  total,
  iconOnly,
}: {
  /** 'login' | 'opera' —— 同时决定接口路径、权限码和文案 */
  kind: 'login' | 'opera'
  /** 当前是否有筛选条件（有的话要额外提醒「删的不只是这些」） */
  filtered: boolean
  /** 当前筛选下的条数，仅用于文案对比 */
  total: number
  /** 只留图标（放在查询区那条密集动作行里时用） */
  iconOnly?: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const label = kind === 'login' ? t('登录日志') : t('操作日志')

  const clear = useMutation({
    mutationFn: () => api.DELETE(`/api/v1/logs/${kind}/all`),
    onSuccess: () => {
      // 列表、统计条、可疑 IP 都挂在同一个前缀下，一起失效
      void qc.invalidateQueries({ queryKey: ['logs', kind] })
      // 仪表盘的今日统计也是从这张表算的
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  /**
   * 只剩图标时必须配 tooltip + `aria-label`。
   * 这是**破坏性动作**，图标化的前提是后面还有 `ConfirmDialog` 兜着 ——
   * 误点一下只会开一个确认框，不会真删。
   */
  const trigger = (
    <Button
      size="sm"
      variant="outline"
      aria-label={t('清空{{what}}', { what: label })}
      className={
        iconOnly
          ? 'size-8 p-0 text-destructive hover:text-destructive'
          : 'text-destructive hover:text-destructive'
      }
      data-testid={`clear-${kind}-logs`}
      onClick={() => {
        setError(null)
        setOpen(true)
      }}
    >
      <IconTrash className="size-4" />
      {!iconOnly && t('清空')}
    </Button>
  )

  return (
    <Can perm={`log:${kind}:clear`}>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>{t('清空{{what}}', { what: label })}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}

      <ConfirmDialog
        open={open}
        onOpenChange={(o) => !o && setOpen(false)}
        title={t('清空{{what}}', { what: label })}
        description={
          error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <span className="flex flex-col gap-1.5">
              <span>
                <Trans
                  t={t}
                  i18nKey="将删除<b>全部</b>{{what}}，此操作不可撤销。"
                  values={{ what: label }}
                  components={{ b: <strong /> }}
                />
              </span>
              {filtered && (
                // 最容易误解的一点：用户刚筛完一批，会以为「清空」清的是筛出来的那批
                <span className="text-amber-700 dark:text-amber-300">
                  <Trans
                    t={t}
                    i18nKey="注意：清空<b>不受当前筛选影响</b> —— 删的是整张表，不是你现在筛出来的这 {{total}} 条。"
                    values={{ total }}
                    components={{ b: <strong /> }}
                  />
                </span>
              )}
            </span>
          )
        }
        confirmText={t("清空")}
        destructive
        pending={clear.isPending}
        onConfirm={async () => {
          setError(null)
          try {
            await clear.mutateAsync()
            setOpen(false)
          } catch (e) {
            // 失败要留在弹窗里说清楚，不要静默关闭
            setError(e instanceof ApiError ? e.message : t('清空失败'))
          }
        }}
      />
    </Can>
  )
}
