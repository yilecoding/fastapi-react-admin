import { useQuery } from '@tanstack/react-query'
import { IconAlertTriangle, IconLock } from '@tabler/icons-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@admin/ui/components/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { ApiError } from '../../api-client/errors'
import { CHANNELS, myPrefsQuery, useUpdateMyPrefs, type Channel, type PrefCell } from '../notify-policy/api'
import { channelLabel, modeLabel } from '../notify-policy/labels'

/**
 * 个人中心 → 通知偏好（#166）：我自己每一类通知收哪几条渠道。
 *
 * - 只有管理员设成「默认发 / 默认不发」的格子能改；「必发 / 不发」和站内显示成锁，并说明为什么
 * - 拨一下就存（没有「保存」按钮）：一格就是一个独立的决定，攒着一起存的话，切走面板再回来不知道存没存
 * - 没绑邮箱 / 手机号时那一列标出来：开着也收不到（后端记成「跳过」），不提示的话人会以为开了就有
 */
export function NotifyPrefsPanel() {
  const { t } = useTranslation()
  const query = useQuery(myPrefsQuery())
  const update = useUpdateMyPrefs()
  const [error, setError] = React.useState<string | null>(null)

  if (query.error && !query.data) {
    return <QueryError error={query.error} onRetry={() => void query.refetch()} />
  }
  if (!query.data) {
    return <Skeleton className="h-48" />
  }
  const { items, has_email, has_phone } = query.data
  const missing: Partial<Record<Channel, boolean>> = { email: !has_email, sms: !has_phone }

  async function toggle(kind: string, channel: Channel, enabled: boolean) {
    setError(null)
    try {
      await update.mutateAsync([{ kind, channel, enabled }])
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="notify-prefs">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('站内通知总会进铃铛。邮件和短信按管理员定的规则发，标了锁的那几格由管理员统一设置。')}
      </p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" data-testid="notify-prefs-error">
          <IconAlertTriangle className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('通知类型')}</TableHead>
              {CHANNELS.map((c) => (
                <TableHead key={c} className="text-center">
                  <span className="flex flex-col items-center">
                    {channelLabel(t, c)}
                    {missing[c] ? (
                      <span className="text-[11px] font-normal text-amber-600 dark:text-amber-400" data-testid={`prefs-missing-${c}`}>
                        {c === 'email' ? t('没绑邮箱') : t('没绑手机号')}
                      </span>
                    ) : null}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.kind} data-testid={`prefs-row-${row.kind}`}>
                <TableCell className="text-sm">{t(row.label)}</TableCell>
                {CHANNELS.map((c) => (
                  <TableCell key={c} className="text-center">
                    <PrefToggle
                      cell={row.cells.find((x) => x.channel === c)}
                      testId={`prefs-${row.kind}-${c}`}
                      busy={update.isPending}
                      onChange={(v) => void toggle(row.kind, c, v)}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function PrefToggle({
  cell,
  busy,
  onChange,
  testId,
}: {
  cell: PrefCell | undefined
  busy: boolean
  onChange: (v: boolean) => void
  testId: string
}) {
  const { t } = useTranslation()
  if (!cell) {
    return (
      <span className="text-muted-foreground" title={t('这一类通知不支持这条渠道')}>
        —
      </span>
    )
  }
  if (!cell.configurable) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              data-testid={testId}
              data-locked="true"
            />
          }
        >
          <IconLock className="size-3.5" />
          {cell.enabled ? t('收') : t('不收')}
        </TooltipTrigger>
        <TooltipContent>{t('管理员设为「{{mode}}」', { mode: modeLabel(t, cell.mode) })}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Switch
      checked={cell.enabled}
      disabled={busy}
      onCheckedChange={(v) => onChange(Boolean(v))}
      aria-label={cell.enabled ? t('收') : t('不收')}
      data-testid={testId}
    />
  )
}
