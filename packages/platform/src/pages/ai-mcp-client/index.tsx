import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconKey, IconPencil, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react'
import * as React from 'react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { StatusBadge } from '../_shared/status'
import {
  mcpClientsQuery,
  useDeleteMcpClient,
  useRotateMcpClient,
  type IssuedToken,
  type McpClient,
} from './api'
import { McpClientFormSheet } from './form'
import { TokenDialog } from './token-dialog'

/**
 * MCP 凭据：给外部系统发「调 AI 工具」的身份。
 *
 * 卡片流而不是表格，理由同模型密钥管理页：凭据天然只有几份（一个外部系统一份）。
 */
export function AiMcpClientPage() {
  const { t } = useTranslation()
  const listQuery = useQuery(mcpClientsQuery())
  const rotate = useRotateMcpClient()
  const del = useDeleteMcpClient()

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<McpClient | null>(null)
  const [issued, setIssued] = React.useState<IssuedToken | null>(null)
  const [pendingRotate, setPendingRotate] = React.useState<McpClient | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<McpClient | null>(null)

  const clients = listQuery.data?.items ?? []

  function openSheet(target: McpClient | null) {
    setEditing(target)
    setSheetOpen(true)
  }

  return (
    <div className="flex flex-1 flex-col gap-4 py-3 content-scroll:min-h-0">
      <p className="text-sm text-muted-foreground">
        {t('外部系统（如 pis-agent、Claude Desktop）用这里发的令牌调用 AI 查询工具。库里只存令牌的哈希，明文只在生成时显示一次。')}
      </p>

      {listQuery.error ? (
        <QueryError error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : listQuery.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        // 「新建」是网格的最后一格，理由同模型密钥管理页
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-lg border p-4" data-testid="mcp-client-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    <StatusBadge value={c.status} />
                    {c.allow_superuser ? <Badge variant="destructive">{t('可代表超管')}</Badge> : null}
                    {c.allow_write ? <Badge variant="secondary">{t('可发起写操作')}</Badge> : null}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">mcp:{c.client_id}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Can perm="ai:mcp:edit">
                    <Button size="icon" variant="ghost" className="size-7" aria-label={t('编辑')} onClick={() => openSheet(c)}>
                      <IconPencil className="size-4" />
                    </Button>
                  </Can>
                  <Can perm="ai:mcp:del">
                    <Button size="icon" variant="ghost" className="size-7" aria-label={t('删除')} onClick={() => setPendingDelete(c)}>
                      <IconTrash className="size-4" />
                    </Button>
                  </Can>
                </div>
              </div>

              <dl className="space-y-1.5 text-xs">
                <Row label={t('令牌')}>
                  <span className="font-mono">{c.token_hint}</span>
                </Row>
                <Row label={t('代表')}>
                  <span className="font-mono">{c.act_as.includes('*') ? t('任何普通用户') : c.act_as.join('、')}</span>
                </Row>
                <Row label={t('工具')}>{c.tools ? <span className="font-mono">{c.tools.join('、')}</span> : t('不限（按被代表的人的权限）')}</Row>
                <Row label={t('限流')}>
                  {c.rate_per_minute ? t('每分钟 {{n}} 次', { n: c.rate_per_minute }) : t('全局默认')}
                </Row>
                <Row label={t('最近使用')}>{c.last_used_time ? formatDateTime(c.last_used_time) : t('从未使用')}</Row>
              </dl>

              <Can perm="ai:mcp:edit">
                <div>
                  <Button size="sm" variant="outline" onClick={() => setPendingRotate(c)}>
                    <IconRefresh className="size-4" />
                    {t('重新生成令牌')}
                  </Button>
                </div>
              </Can>
            </div>
          ))}

          <Can perm="ai:mcp:add">
            <button
              type="button"
              onClick={() => openSheet(null)}
              className="flex min-h-48 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
            >
              {clients.length ? <IconPlus className="size-5" /> : <IconKey className="size-5" />}
              <span className="text-sm">{t('新建凭据')}</span>
              {clients.length === 0 ? (
                <span className="max-w-60 text-xs text-balance">{t('给一个外部系统发一把令牌，它就能以指定用户的身份调用查询工具')}</span>
              ) : null}
            </button>
          </Can>
        </div>
      )}

      <McpClientFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} onIssued={setIssued} />
      <TokenDialog issued={issued} onClose={() => setIssued(null)} />

      <ConfirmDialog
        open={pendingRotate !== null}
        onOpenChange={(o) => !o && setPendingRotate(null)}
        title={t('重新生成令牌')}
        description={t('「{{name}}」现在用的令牌会立即失效，对方系统要换成新令牌才能继续调用。', {
          name: pendingRotate?.name ?? '',
        })}
        onConfirm={async () => {
          if (pendingRotate) setIssued(await rotate.mutateAsync(pendingRotate.id))
          setPendingRotate(null)
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除 MCP 凭据')}
        description={t('确定删除「{{name}}」？它的令牌会立即失效，已有的调用日志保留。', { name: pendingDelete?.name ?? '' })}
        onConfirm={async () => {
          if (pendingDelete) await del.mutateAsync(pendingDelete.id)
          setPendingDelete(null)
        }}
      />
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}
