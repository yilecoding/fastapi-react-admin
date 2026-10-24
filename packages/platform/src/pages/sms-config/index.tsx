import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconPencil, IconPlus, IconSend, IconStar, IconTrash } from '@tabler/icons-react'
import * as React from 'react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { StatusBadge } from '../_shared/status'
import {
  smsConfigsQuery,
  smsProvidersQuery,
  smsTemplatesQuery,
  useDeleteSmsConfig,
  useSetDefaultSmsConfig,
  type SmsConfig,
  type TemplatePreset,
} from './api'
import { SmsConfigFormSheet } from './form'
import { SmsTestDialog } from './test-dialog'

/**
 * 短信配置（issue #153，对标 ContiNew Admin 的「短信配置」）。
 *
 * 卡片流而不是 DataTable，理由同 AI 供应商 / 存储：配置天然只有几条（系统配置那一类），
 * 分页 / 筛选 / 列显隐都是过度设计。每张卡上就是 issue 里要的那几列：
 * 名称 · 厂商 · 签名 · 已配模板 · 权重 · 今日已发 / 日上限 · 默认 · 状态 · 行操作。
 */
export function SmsConfigPage() {
  const { t } = useTranslation()
  const listQuery = useQuery(smsConfigsQuery())
  const providersQuery = useQuery(smsProvidersQuery())
  const templatesQuery = useQuery(smsTemplatesQuery())
  const del = useDeleteSmsConfig()
  const setDefault = useSetDefaultSmsConfig()

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<SmsConfig | null>(null)
  // 测试弹窗「用这个模板配 xx」带过来的预填，只活到编辑表单关掉
  const [preset, setPreset] = React.useState<TemplatePreset | null>(null)
  const [testing, setTesting] = React.useState<SmsConfig | null>(null)
  // 测试弹窗的「挂载」和「打开」分开管：正常关闭只翻 open（有退场动画）；从弹窗里跳去日志页时要在同一次
  // 提交里把它卸掉 —— 这个 tab 马上进后台，退场动画的 effect 跑不完，弹窗会留在屏幕上（见 test-dialog.tsx）
  const [testDialogMounted, setTestDialogMounted] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<SmsConfig | null>(null)
  const [pendingDefault, setPendingDefault] = React.useState<SmsConfig | null>(null)

  const configs = listQuery.data?.items ?? []
  const providers = React.useMemo(() => new Map((providersQuery.data ?? []).map((p) => [p.code, p])), [providersQuery.data])
  const templateLabels = React.useMemo(
    () => new Map((templatesQuery.data ?? []).map((tpl) => [tpl.code, tpl.label])),
    [templatesQuery.data],
  )

  /** 「停用的不能设默认」这类是后端拦的，失败由全局 toast 展示（硬纪律 9），这里只吞 rejection */
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
    } catch {
      /* 已由全局 toast 展示 */
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 py-3 content-scroll:min-h-0">
      <p className="text-sm text-muted-foreground">
        {t('使用方只认业务模板码，这里把它对到每家厂商自己的模板。有默认配置就先用它，到了日上限再按权重分给备用；凭据加密落库，界面上只显示掩码。')}
      </p>

      {/* 厂商 / 模板目录拉不下来时卡片照样能列，但「厂商不可用」的判断和新增表单都会失真：错误要显示出来（硬纪律 9） */}
      {providersQuery.error ? <QueryError error={providersQuery.error} onRetry={() => providersQuery.refetch()} /> : null}
      {templatesQuery.error ? <QueryError error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} /> : null}

      {listQuery.error ? (
        <QueryError error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : listQuery.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {configs.map((config) => {
            const provider = providers.get(config.provider)
            const mapped = Object.keys(config.templates)
            const unknownProvider = providersQuery.data !== undefined && !provider
            return (
              <div key={config.id} className="flex flex-col gap-2 rounded-lg border p-4" data-testid={`sms-config-card-${config.name}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium">{config.name}</span>
                      {config.is_default ? <Badge variant="secondary">{t('默认')}</Badge> : null}
                      <StatusBadge value={config.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {provider ? t(provider.label) : <span className="font-mono">{config.provider}</span>}
                      {' · '}
                      {config.sign_name}
                    </p>
                    {unknownProvider ? (
                      // 生产环境不注册 console，库里却可能留着一条：说清楚它为什么发不出去（硬纪律 9）
                      <p className="mt-1 text-xs text-destructive">{t('这家厂商在当前环境不可用，发送会被拒绝')}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Can perm="sms:config:edit">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={t('编辑')}
                        onClick={() => {
                          setEditing(config)
                          setSheetOpen(true)
                        }}
                      >
                        <IconPencil className="size-4" />
                      </Button>
                    </Can>
                    <Can perm="sms:config:del">
                      <Button size="icon" variant="ghost" className="size-7" aria-label={t('删除')} onClick={() => setPendingDelete(config)}>
                        <IconTrash className="size-4" />
                      </Button>
                    </Can>
                  </div>
                </div>

                <dl className="space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-muted-foreground">{t('业务模板')}</dt>
                    <dd className="flex min-w-0 flex-wrap gap-1">
                      {mapped.length === 0 ? (
                        <span className="text-amber-700 dark:text-amber-300">{t('一个都没配 —— 发不了任何业务短信')}</span>
                      ) : (
                        mapped.map((code) => (
                          <Badge key={code} variant="outline" className="font-normal">
                            {t(templateLabels.get(code) ?? code)}
                            <span className="ms-1 font-mono text-muted-foreground">{config.templates[code]?.template_id}</span>
                          </Badge>
                        ))
                      )}
                    </dd>
                  </div>
                  {config.secret_mask ? (
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-muted-foreground">{t('凭据')}</dt>
                      <dd className="min-w-0 truncate font-mono">
                        {config.access_key_id} · {config.secret_mask}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-muted-foreground">{t('今日已发')}</dt>
                    <dd className="tabular-nums">
                      {config.today_sent}
                      {config.daily_max > 0 ? ` / ${config.daily_max}` : ` / ${t('不限')}`}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-muted-foreground">{t('权重')}</dt>
                    <dd className="tabular-nums">
                      {config.weight === 0 ? t('0（只能被指定）') : config.weight}
                      <span className="ms-2 text-muted-foreground">
                        {t('超时')} {config.timeout}s
                      </span>
                    </dd>
                  </div>
                </dl>

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  {config.is_default ? null : (
                    <Can perm="sms:config:edit">
                      <Button size="sm" variant="outline" disabled={config.status !== 1 || setDefault.isPending} onClick={() => setPendingDefault(config)}>
                        <IconStar className="size-4" />
                        {t('设为默认')}
                      </Button>
                    </Can>
                  )}
                  <Can perm="sms:config:test">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={config.status !== 1}
                      onClick={() => {
                        setTestDialogMounted(true)
                        setTesting(config)
                      }}
                      data-testid={`sms-config-test-${config.name}`}
                    >
                      <IconSend className="size-4" />
                      {t('发测试短信')}
                    </Button>
                  </Can>
                </div>
              </div>
            )
          })}

          <Can perm="sms:config:add">
            <button
              type="button"
              onClick={() => {
                setEditing(null)
                setSheetOpen(true)
              }}
              className="flex min-h-52 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
              data-testid="sms-config-add"
            >
              <IconPlus className="size-5" />
              <span className="text-sm">{t('新增短信配置')}</span>
              {configs.length === 0 ? (
                <span className="max-w-60 text-xs text-balance">
                  {t('开发期先建一条「控制台」厂商的配置跑通流程；接真厂商时换成阿里云 / 腾讯云并发一条测试短信')}
                </span>
              ) : null}
            </button>
          </Can>
        </div>
      )}

      <SmsConfigFormSheet
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o)
          if (!o) setPreset(null)
        }}
        editing={editing}
        preset={preset}
      />
      {testDialogMounted ? (
        <SmsTestDialog
          open={testing !== null}
          onOpenChange={(o) => !o && setTesting(null)}
          onLeave={() => {
            setTesting(null)
            setTestDialogMounted(false)
          }}
          config={testing}
          provider={testing ? (providers.get(testing.provider) ?? null) : null}
          templates={templatesQuery.data ?? []}
          onAdopt={(p) => {
            // 测通 → 直接进这条配置的编辑表单，模板 ID 和变量名已经填好
            setPreset(p)
            setEditing(testing)
            setTesting(null)
            setSheetOpen(true)
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDefault !== null}
        onOpenChange={(o) => !o && setPendingDefault(null)}
        title={t('切换默认配置')}
        description={t('之后自动选配置时都会先用「{{name}}」；原来的默认标记会被清掉。', { name: pendingDefault?.name ?? '' })}
        onConfirm={async () => {
          const target = pendingDefault
          setPendingDefault(null)
          if (target) await run(() => setDefault.mutateAsync(target.id))
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除短信配置')}
        destructive
        description={t('确定删除「{{name}}」？已有的发送日志会保留（日志里冗余记了厂商）。', { name: pendingDelete?.name ?? '' })}
        onConfirm={async () => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) await run(() => del.mutateAsync(target.id))
        }}
      />
    </div>
  )
}
