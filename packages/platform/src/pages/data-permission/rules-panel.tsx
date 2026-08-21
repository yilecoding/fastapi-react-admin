import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle, IconLink, IconPencil, IconPlus, IconTrash, IconUnlink,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { DataTableSkeletonRows } from '@admin/ui/components/data-table'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { usePerm } from '../../auth/use-perm'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { TONE_CLASS } from '../_shared/status'
import {
  expressionSymbol, scopeRulesQuery, useDeleteDataRules, useUpdateScopeRules,
  type DataRule, type DataScope,
} from './api'
import { RulePicker } from './rule-picker'
import { DataRuleSheet } from './rule-form'

/**
 * 某个数据范围下的规则。
 *
 * 主操作是「新建规则」—— 建完直接挂上，一步到位。原先要跑到「数据规则」页建、
 * 再回「数据范围」页的抽屉里勾，四屏才能加一个条件，而且中途忘了勾就留下孤儿规则。
 * 「引用已有规则」降级成次要按钮，留给真要跨范围复用的场景（实测目前零复用）。
 */
export function RulesPanel({ scope }: { scope: DataScope }) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const canBind = can('data:scope:rule:edit')

  const { data: rules = [], isPending } = useQuery(scopeRulesQuery(scope.id))

  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<DataRule | null>(null)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [pendingUnbind, setPendingUnbind] = React.useState<DataRule | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<DataRule | null>(null)

  const bind = useUpdateScopeRules()
  const delRule = useDeleteDataRules()

  const ids = rules.map((r) => r.id)

  /** 混用告警：一条 OR 规则会绕过全局所有 AND 规则，配错了很难查 */
  const hasAnd = rules.some((r) => r.operator === 0)
  const hasOr = rules.some((r) => r.operator === 1)
  const mixed = hasAnd && hasOr

  return (
    <div className="flex flex-col gap-3" data-testid="rules-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Can perm="data:rule:add">
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true) }} data-testid="rule-add">
            <IconPlus className="size-4" />{t('新建规则')}
          </Button>
        </Can>
        <Can perm="data:scope:rule:edit">
          <Button variant="outline" size="sm" className="h-8" onClick={() => setPickerOpen(true)}
                  data-testid="rule-link">
            <IconLink className="size-4" />{t('引用已有规则')}
          </Button>
        </Can>
        <span className="text-sm text-muted-foreground" data-testid="rule-count">
          {t('共 {{n}} 条规则', { n: rules.length })}
        </span>
        {scope.status !== 1 && (
          <span className={cn('rounded-full px-2 py-0.5 text-xs ring-1', TONE_CLASS.warning)}
                data-testid="scope-disabled">
            {t('范围已停用，这些规则不生效')}
          </span>
        )}
      </div>

      {mixed && (
        <p className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs ring-1', TONE_CLASS.warning)}
           data-testid="rule-mixed-warn">
          <IconAlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            <Trans
              t={t}
              i18nKey="本范围同时有 AND 和 OR 规则。后端不是按范围分组求值的 —— 所有角色、所有范围里的规则会被拍平成 <c>or_( and_(全部 AND), or_(全部 OR) )</c>，<b>任意一条 OR 规则都会绕过全部 AND 规则</b>。除非确实想放宽，否则同一范围内建议统一用 AND。"
              components={{ c: <code />, b: <b /> }}
            />
          </span>
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border" data-testid="rules-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-48">{t('规则名称')}</TableHead>
              <TableHead>{t('作用模型')}</TableHead>
              <TableHead>{t('条件')}</TableHead>
              <TableHead className="w-28">{t('连接方式')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <DataTableSkeletonRows rows={4} columns={5} />
            ) : rules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                  {t('这个范围下还没有规则。绑到角色上也不会放行任何数据 —— 先加一条。')}
                </TableCell>
              </TableRow>
            ) : (
              rules.map((r) => (
                <TableRow key={r.id} data-testid={`rule-row-${r.id}`}>
                  <TableCell className="text-sm font-medium">{r.name}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1 text-[11px]">
                      {r.model === '__ALL__' ? t('全部模型') : r.model}
                    </code>
                  </TableCell>
                  <TableCell className="text-sm">
                    <code className="text-[11px]">
                      {r.column} {expressionSymbol(r.expression)} {r.value}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.operator === 1 ? 'secondary' : 'outline'} className="font-normal">
                      {r.operator === 1 ? 'OR' : 'AND'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center justify-end gap-1">
                      <Can perm="data:rule:edit">
                        <Button variant="ghost" size="icon" className="size-7" aria-label={t('编辑 {{name}}', { name: r.name })}
                                onClick={() => { setEditing(r); setFormOpen(true) }}
                                data-testid={`rule-edit-${r.id}`}>
                          <IconPencil className="size-4" />
                        </Button>
                      </Can>
                      <Can perm="data:scope:rule:edit">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost" size="icon" className="size-7"
                                aria-label={t('从本范围移除 {{name}}', { name: r.name })}
                                onClick={() => setPendingUnbind(r)}
                              />
                            }
                            data-testid={`rule-unbind-${r.id}`}
                          >
                            <IconUnlink className="size-4" />
                          </TooltipTrigger>
                          <TooltipContent>{t('从本范围移除（规则本身保留）')}</TooltipContent>
                        </Tooltip>
                      </Can>
                      <Can perm="data:rule:del">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost" size="icon"
                                className="size-7 text-destructive hover:text-destructive"
                                aria-label={t('彻底删除 {{name}}', { name: r.name })}
                                onClick={() => setPendingDelete(r)}
                              />
                            }
                            data-testid={`rule-delete-${r.id}`}
                          >
                            <IconTrash className="size-4" />
                          </TooltipTrigger>
                          <TooltipContent>{t('彻底删除规则（所有范围都会失去它）')}</TooltipContent>
                        </Tooltip>
                      </Can>
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <DataRuleSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        // 新建即挂上 —— 不做这一步就是下一条孤儿规则
        onCreated={canBind ? async (rule) => { await bind.mutateAsync({ id: scope.id, rules: [...ids, rule.id] }) } : undefined}
      />

      <RulePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        scope={scope}
        boundIds={ids}
      />

      <ConfirmDialog
        open={pendingUnbind !== null}
        onOpenChange={(o) => !o && setPendingUnbind(null)}
        title={t("从本范围移除规则")}
        description={
          pendingUnbind
            ? t('把「{{rule}}」从范围「{{scope}}」里摘掉？规则本身还在，其它范围不受影响。', { rule: pendingUnbind.name, scope: scope.name })
            : ''
        }
        confirmText={t("移除")}
        destructive
        pending={bind.isPending}
        onConfirm={async () => {
          if (!pendingUnbind) return
          await bind.mutateAsync({ id: scope.id, rules: ids.filter((x) => x !== pendingUnbind.id) })
          setPendingUnbind(null)
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("彻底删除规则")}
        description={
          pendingDelete
            ? t('删除规则「{{name}}」？这会从所有引用它的数据范围里一并消失，不只是本范围。', { name: pendingDelete.name })
            : ''
        }
        confirmText={t("删除")}
        destructive
        pending={delRule.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          await delRule.mutateAsync([pendingDelete.id])
          setPendingDelete(null)
        }}
      />
    </div>
  )
}
