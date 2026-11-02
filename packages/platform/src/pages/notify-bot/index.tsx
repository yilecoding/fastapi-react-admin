import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { IconListDetails, IconPencil, IconSend, IconTrash } from '@tabler/icons-react'
import * as React from 'react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { AddCard, CardField, CardFields } from '../_shared/resource-card'
import { StatusBadge } from '../_shared/status'
import { botOptionsQuery, botsQuery, useDeleteBot, useTestBot, type Bot } from './api'
import { BotFormSheet } from './form'
import { botReasonLabel, platformLabel } from './labels'
import { PageHeader } from '../../shell/page-header'

/**
 * 群机器人（#166 二期）。卡片流而不是 DataTable，理由同短信配置：系统配置那一类，天然只有几条。
 *
 * 每张卡：名称 · 平台 · 地址掩码 · 有没有加签 · 订阅的通知 · 最近一次成功 / 失败原因 · 发测试消息。
 * 组件 router-独立：没有 search 参数（一页就这些卡）。
 */
export function NotifyBotPage() {
  const { t } = useTranslation()
  const listQuery = useQuery(botsQuery())
  const optionsQuery = useQuery(botOptionsQuery())
  const del = useDeleteBot()
  const test = useTestBot()
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Bot | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Bot | null>(null)
  const [testingId, setTestingId] = React.useState<string | null>(null)

  const bots = listQuery.data ?? []
  const kindLabels = React.useMemo(
    () => new Map((optionsQuery.data?.kinds ?? []).map((k) => [k.kind, k.label])),
    [optionsQuery.data],
  )

  async function sendTest(bot: Bot) {
    setTestingId(bot.id)
    try {
      const r = await test.mutateAsync(bot.id)
      if (r.ok) toast.success(t('测试消息已发到「{{name}}」，去群里看一眼', { name: bot.name }))
      else {
        const reason = (r.reason && botReasonLabel(t, r.reason)) ?? r.reason ?? t('发送失败')
        toast.error(r.error ? `${reason}：${r.error}` : reason)
      }
    } catch {
      /* 已由全局 toast 展示（硬纪律 9） */
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 content-scroll:min-h-0">
      <PageHeader title={t('群机器人')} description={t('把公告、审批结果这类对谁都说得通的通知推到飞书 / 钉钉 / 企业微信群里。一条通知一个群只推一次，失败会按通知策略的退避重试，记录在「投递记录」里。')} />

      {optionsQuery.error ? <QueryError error={optionsQuery.error} onRetry={() => optionsQuery.refetch()} /> : null}

      {listQuery.error ? (
        <QueryError error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : listQuery.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot) => (
            <div key={bot.id} className="flex flex-col gap-2 rounded-lg border bg-card p-4" data-testid={`bot-card-${bot.name}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{bot.name}</span>
                    <StatusBadge value={bot.status} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {platformLabel(t, bot.platform)}
                    {' · '}
                    {bot.has_secret ? t('已开签名校验') : t('未开签名校验')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Can perm="sys:notification:bot:edit">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('编辑')}
                      data-testid={`bot-edit-${bot.name}`}
                      onClick={() => {
                        setEditing(bot)
                        setSheetOpen(true)
                      }}
                    >
                      <IconPencil className="size-4" />
                    </Button>
                  </Can>
                  <Can perm="sys:notification:bot:del">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('删除')}
                      data-testid={`bot-delete-${bot.name}`}
                      onClick={() => setPendingDelete(bot)}
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  </Can>
                </div>
              </div>

              <CardFields>
                <CardField label={t('地址')} className="truncate font-mono" testId={`bot-hint-${bot.name}`}>
                  {bot.webhook_hint}
                </CardField>
                <CardField label={t('订阅')} className="flex flex-wrap gap-1">
                  {bot.kinds.map((k) => (
                    <Badge key={k} variant="outline" className="font-normal">
                      {kindLabels.has(k) ? t(kindLabels.get(k) ?? k) : <span className="font-mono">{k}</span>}
                    </Badge>
                  ))}
                </CardField>
                <CardField label={t('最近成功')} className="font-mono tabular-nums">{formatDateTime(bot.last_sent_time)}</CardField>
                {bot.last_error ? (
                  <CardField label={t('最近失败')} className="break-all text-destructive" testId={`bot-last-error-${bot.name}`}>
                    {bot.last_error}
                  </CardField>
                ) : null}
              </CardFields>

              <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                <Can perm="sys:notification:bot:test">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testingId !== null}
                    aria-busy={testingId === bot.id}
                    onClick={() => void sendTest(bot)}
                    data-testid={`bot-test-${bot.name}`}
                  >
                    <IconSend className="size-4" />
                    {testingId === bot.id ? t('发送中…') : t('发测试消息')}
                  </Button>
                </Can>
                <Can perm="sys:notification:delivery:list">
                  <Button
                    size="sm"
                    variant="ghost"
                    nativeButton={false}
                    render={<Link to="/notify/delivery" search={{ channel: 'bot' }} />}
                  >
                    <IconListDetails className="size-4" />
                    {t('投递记录')}
                  </Button>
                </Can>
              </div>
            </div>
          ))}

          <Can perm="sys:notification:bot:add">
            <AddCard
              label={t('新增群机器人')}
              onClick={() => {
                setEditing(null)
                setSheetOpen(true)
              }}
              hint={bots.length === 0 ? t('在群里添加一个「自定义机器人」，把它的 Webhook 地址粘过来，再发一条测试消息确认通了') : undefined}
              testId="bot-add"
            />
          </Can>
        </div>
      )}

      <BotFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除群机器人')}
        destructive
        description={t('确定删除「{{name}}」？还没发出去的消息会停发，已有的投递记录保留。', { name: pendingDelete?.name ?? '' })}
        onConfirm={async () => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) {
            try {
              await del.mutateAsync(target.id)
            } catch {
              /* 已由全局 toast 展示 */
            }
          }
        }}
      />
    </div>
  )
}
