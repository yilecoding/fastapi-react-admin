import { useQuery } from '@tanstack/react-query'
import { IconDeviceFloppy, IconRestore } from '@tabler/icons-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@admin/ui/components/select'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@admin/ui/components/table'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import { Can } from '../../auth/can'
import { usePerm } from '../../auth/use-perm'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton } from '../_shared/filters'
import { CHANNELS, policiesQuery, useUpdatePolicies, type Channel, type PolicyMode, type PolicyRow } from './api'
import { channelLabel, modeLabel } from './labels'

const MODES: PolicyMode[] = ['off', 'default_on', 'default_off', 'forced']

type Draft = Record<string, PolicyMode>
const cellKey = (kind: string, channel: Channel) => `${kind}|${channel}`

/**
 * 通知策略（#166）：通知类型 × 渠道的系统默认。
 *
 * - 行由后端注册表给（各插件声明的通知类型），某个类型不支持的渠道那一格是「—」
 * - 站内一律「必发」不可改；广播类（公告 / 每日问候）只有站内一格
 * - 「默认发 / 默认不发」两档用户能在个人中心自己改；「必发 / 不发」用户改不了
 * - 草稿是 `draft ?? 服务端值` 两层（pages 分册「主从页 · 其他约定」）：后台 refetch 回来不冲掉没存的改动
 *
 * 组件 router-独立：没有 search 参数（一页就一张矩阵）。
 */
export function NotifyPolicyPage() {
  const { t } = useTranslation()
  const { can } = usePerm()
  const editable = can('sys:notification:policy:edit')
  const query = useQuery(policiesQuery())
  const update = useUpdatePolicies()
  const [draft, setDraft] = React.useState<Draft>({})
  const [error, setError] = React.useState<string | null>(null)

  const rows = query.data ?? []
  const dirty = Object.keys(draft).length > 0

  const setMode = (row: PolicyRow, channel: Channel, mode: PolicyMode) => {
    const server = row.cells.find((c) => c.channel === channel)?.mode
    setDraft((d) => {
      const next = { ...d }
      if (mode === server) delete next[cellKey(row.kind, channel)]
      else next[cellKey(row.kind, channel)] = mode
      return next
    })
  }

  async function save() {
    setError(null)
    const items = Object.entries(draft).map(([k, mode]) => {
      const [kind, channel] = k.split('|') as [string, Channel]
      return { kind, channel, mode }
    })
    try {
      await update.mutateAsync(items)
      setDraft({})
      toast.success(t('通知策略已保存'))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 py-4 md:py-6">
      <PageHeader
        title={t('通知策略')}
        description={t('每一类通知走哪些渠道。「默认发 / 默认不发」用户可以在个人中心自己改，「必发 / 不发」不行。')}
      >
        <RefreshButton busy={query.isFetching} onClick={() => void query.refetch()} />
        <Can perm="sys:notification:policy:edit">
          <Button variant="outline" size="sm" disabled={!dirty || update.isPending} onClick={() => setDraft({})} data-testid="policy-discard">
            <IconRestore />
            {t('放弃修改')}
          </Button>
          <Button size="sm" disabled={!dirty || update.isPending} onClick={() => void save()} data-testid="policy-save">
            <IconDeviceFloppy />
            {dirty ? t('保存（{{n}} 处）', { n: Object.keys(draft).length }) : t('保存')}
          </Button>
        </Can>
      </PageHeader>

      {error && (
        <p className="text-sm text-destructive" data-testid="policy-error">
          {error}
        </p>
      )}

      {query.error && !query.data ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="overflow-x-auto rounded-lg border" data-testid="policy-matrix">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-64">{t('通知类型')}</TableHead>
                {CHANNELS.map((c) => (
                  <TableHead key={c}>{channelLabel(t, c)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isPending
                ? Array.from({ length: 6 }, (_, i) => (
                    <TableRow key={i}>
                      {[0, 1, 2, 3].map((j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-8 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : rows.map((row) => (
                    <TableRow key={row.kind} data-testid={`policy-row-${row.kind}`}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{t(row.label)}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {row.kind}
                            {row.broadcast ? ` · ${t('全员广播')}` : ''}
                            {!row.user_configurable && !row.broadcast ? ` · ${t('个人不能改')}` : ''}
                          </span>
                        </div>
                      </TableCell>
                      {CHANNELS.map((c) => {
                        const cell = row.cells.find((x) => x.channel === c)
                        if (!cell) {
                          return (
                            <TableCell key={c} className="text-muted-foreground" title={t('这一类通知不支持这条渠道')}>
                              —
                            </TableCell>
                          )
                        }
                        const value = draft[cellKey(row.kind, c)] ?? cell.mode
                        const changed = cellKey(row.kind, c) in draft
                        if (!cell.editable || !editable) {
                          return (
                            <TableCell key={c} className="text-sm">
                              {modeLabel(t, value)}
                            </TableCell>
                          )
                        }
                        return (
                          <TableCell key={c}>
                            <Select
                              value={value}
                              items={MODES.map((m) => ({ value: m, label: modeLabel(t, m) }))}
                              onValueChange={(v) => setMode(row, c, v as PolicyMode)}
                            >
                              <SelectTrigger
                                className={cn('h-8 w-40', changed && 'ring-2 ring-amber-500/50')}
                                data-testid={`policy-${row.kind}-${c}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {MODES.map((m) => (
                                  <SelectItem key={m} value={m}>
                                    {modeLabel(t, m)}
                                    {m === cell.default ? ` · ${t('默认')}` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t('短信只能发运营商审核过的模板，所以只有「催办」「超时提醒」支持短信，要先在「短信配置」里把业务模板对到厂商模板。没有邮箱 / 手机号的人那一条会记成「跳过」，在投递记录里看得到。')}
      </p>
    </div>
  )
}
