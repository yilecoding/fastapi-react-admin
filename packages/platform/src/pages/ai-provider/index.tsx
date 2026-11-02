import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconCheck, IconPencil, IconPlugConnected, IconTrash, IconX } from '@tabler/icons-react'
import * as React from 'react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { AddCard, CardField, CardFields, CardPageRefresh, ResourceCard } from '../_shared/resource-card'
import { StatusBadge } from '../_shared/status'
import {
  PROVIDER_TYPE_LABELS,
  providersQuery,
  useDeleteProvider,
  useTestProvider,
  type AiProvider,
  type TestResult,
} from './api'
import { ProviderFormSheet } from './form'
import { PageHeader } from '../../shell/page-header'

/**
 * 模型密钥管理。
 *
 * 用卡片流而不是 DataTable：供应商天然只有几条（不是会无限增长的业务数据），
 * 套完整的分页/筛选/列显隐机制是过度设计，而每一样都要维护。
 */
export function AiProviderPage() {
  const { t } = useTranslation()
  const listQuery = useQuery(providersQuery())
  const del = useDeleteProvider()
  const test = useTestProvider()

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AiProvider | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<AiProvider | null>(null)
  // 测试结果按供应商 id 存：同时测两个不会互相覆盖
  const [results, setResults] = React.useState<Record<string, TestResult>>({})

  const providers = listQuery.data?.items ?? []

  function openCreate() {
    setEditing(null)
    setSheetOpen(true)
  }

  function openEdit(provider: AiProvider) {
    setEditing(provider)
    setSheetOpen(true)
  }

  async function runTest(provider: AiProvider) {
    const result = await test.mutateAsync(provider.id)
    setResults((prev) => ({ ...prev, [provider.id]: result }))
  }

  return (
    <div className="flex flex-1 flex-col gap-4 content-scroll:min-h-0">
      <PageHeader title={t('模型密钥管理')} description={t('AI 助手通过这里配置的供应商调用模型。密钥加密落库，界面上只显示掩码。')}>
        <CardPageRefresh queries={[listQuery]} testId="provider-refresh" />
      </PageHeader>

      {listQuery.error ? (
        <QueryError error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : listQuery.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : (
        /* 🔴 「新增」是网格里的**最后一格**，不是右上角那个浮着的按钮。
           两个理由：
           1. 供应商常年只有一两条，两列/三列网格必然缺角 —— 而右上角那个按钮
              恰好悬在缺角的上方，离它要操作的卡片半屏远（实测差 518px）
           2. 一条都没有时，这一格自己就是空状态 —— 空屏该是邀请动作的地方，
              不是一句"还没有配置"的通知 */
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => {
            const result = results[provider.id]
            return (
              <ResourceCard key={provider.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{provider.name}</span>
                      {provider.is_default ? <Badge variant="secondary">{t('默认')}</Badge> : null}
                      <StatusBadge value={provider.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(PROVIDER_TYPE_LABELS[provider.provider_type])} · {provider.model}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Can perm="ai:provider:edit">
                      <Button size="icon" variant="ghost" className="size-7" aria-label={t('编辑')} onClick={() => openEdit(provider)}>
                        <IconPencil className="size-4" />
                      </Button>
                    </Can>
                    <Can perm="ai:provider:del">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={t('删除')}
                        onClick={() => setPendingDelete(provider)}
                      >
                        <IconTrash className="size-4" />
                      </Button>
                    </Can>
                  </div>
                </div>

                <CardFields>
                  <CardField label={t('地址')} className="truncate font-mono">{provider.base_url}</CardField>
                  <CardField label={t('密钥')} className="font-mono">{provider.api_key_mask}</CardField>
                  <CardField label="TLS">{provider.verify_ssl ? t('校验') : t('不校验（内网自签）')}</CardField>
                </CardFields>

                <div className="flex items-center gap-2">
                  <Can perm="ai:provider:edit">
                    <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => void runTest(provider)}>
                      <IconPlugConnected className="size-4" />
                      {t('测试连通性')}
                    </Button>
                  </Can>
                  {result ? (
                    <span
                      className={`flex items-center gap-1 text-xs ${result.ok ? 'text-emerald-600' : 'text-destructive'}`}
                    >
                      {result.ok ? <IconCheck className="size-3.5" /> : <IconX className="size-3.5" />}
                      {result.ok ? t('连接正常 · {{ms}}ms', { ms: result.latency_ms }) : result.message}
                    </span>
                  ) : null}
                </div>
              </ResourceCard>
            )
          })}

          <Can perm="ai:provider:add">
            <AddCard
              label={t('新增供应商')}
              onClick={openCreate}
              hint={providers.length === 0 ? t('先配一个可用的供应商，AI 助手才能对话') : undefined}
            />
          </Can>
        </div>
      )}

      <ProviderFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除模型供应商')}
        description={t('确定删除「{{name}}」？已经用它创建的会话会回落到默认供应商。', { name: pendingDelete?.name ?? '' })}
        onConfirm={async () => {
          if (pendingDelete) await del.mutateAsync(pendingDelete.id)
          setPendingDelete(null)
        }}
      />
    </div>
  )
}
