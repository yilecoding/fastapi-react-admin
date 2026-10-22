import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  IconCheck,
  IconCloud,
  IconPencil,
  IconPlugConnected,
  IconPlus,
  IconServer2,
  IconStar,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import * as React from 'react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { StatusBadge } from '../_shared/status'
import {
  STORAGE_TYPE_LABELS,
  storagesQuery,
  useDeleteStorage,
  useSetDefaultStorage,
  useSetStorageStatus,
  useTestStorage,
  type Storage,
  type TestResult,
} from './api'
import { StorageFormSheet } from './form'

/**
 * 存储管理。
 *
 * 卡片流而不是 DataTable，理由同 AI 供应商页：存储天然只有几个，分页 / 筛选 / 列显隐都是过度设计。
 * 第一张卡永远是内置本地存储。
 */
export function StoragePage() {
  const { t } = useTranslation()
  const listQuery = useQuery(storagesQuery())
  const del = useDeleteStorage()
  const setDefault = useSetDefaultStorage()
  const setStatus = useSetStorageStatus()
  const test = useTestStorage()

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Storage | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Storage | null>(null)
  const [pendingDefault, setPendingDefault] = React.useState<Storage | null>(null)
  // 测试结果按存储 id 存：同时测两个不会互相覆盖
  const [results, setResults] = React.useState<Record<string, TestResult>>({})

  const storages = listQuery.data ?? []

  /**
   * 「默认存储不能停用」「还有 N 个文件不能删」这些都是后端拦的，失败必须看得见（硬纪律 9）——
   * 由 app 层 `MutationCache.onError` 的全局 toast 负责，这里只吞掉 rejection，别再内联显示一遍
   */
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
    } catch {
      /* 已由全局 toast 展示 */
    }
  }

  async function runTest(storage: Storage) {
    await run(async () => {
      const result = await test.mutateAsync(storage.id)
      setResults((prev) => ({ ...prev, [storage.id]: result }))
    })
  }

  return (
    <div className="flex flex-1 flex-col gap-4 py-3 content-scroll:min-h-0">
      <p className="text-sm text-muted-foreground">
        {t('新上传的文件落在默认存储。切换默认只影响之后的上传，已有文件仍从它原来的存储读取。')}
      </p>

      {listQuery.error ? (
        <QueryError error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : listQuery.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {storages.map((storage) => {
            const result = results[storage.id]
            const TypeIcon = storage.type === 's3' ? IconCloud : IconServer2
            return (
              <div
                key={storage.id}
                className="flex flex-col gap-2 rounded-lg border p-4"
                data-testid={`storage-card-${storage.code}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 gap-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/60">
                      <TypeIcon className="size-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium">{storage.name}</span>
                        {storage.is_default ? <Badge variant="secondary">{t('默认')}</Badge> : null}
                        {storage.builtin ? <Badge variant="outline">{t('内置')}</Badge> : null}
                        <StatusBadge value={storage.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{storage.code}</span> · {t(STORAGE_TYPE_LABELS[storage.type])}
                      </p>
                    </div>
                  </div>
                  {storage.builtin ? null : (
                    <div className="flex shrink-0 gap-1">
                      <Can perm="sys:storage:edit">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          aria-label={t('编辑')}
                          onClick={() => {
                            setEditing(storage)
                            setSheetOpen(true)
                          }}
                        >
                          <IconPencil className="size-4" />
                        </Button>
                      </Can>
                      <Can perm="sys:storage:del">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          aria-label={t('删除')}
                          onClick={() => setPendingDelete(storage)}
                        >
                          <IconTrash className="size-4" />
                        </Button>
                      </Can>
                    </div>
                  )}
                </div>

                <dl className="space-y-1.5 text-xs">
                  {storage.builtin ? (
                    <div className="flex gap-2">
                      <dt className="w-14 shrink-0 text-muted-foreground">{t('位置')}</dt>
                      <dd className="min-w-0 truncate">{t('应用所在机器的上传目录（多副本部署时不共享）')}</dd>
                    </div>
                  ) : storage.type === 'local' ? (
                    <div className="flex gap-2">
                      <dt className="w-14 shrink-0 text-muted-foreground">{t('根目录')}</dt>
                      <dd className="min-w-0 truncate font-mono">{storage.root}</dd>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <dt className="w-14 shrink-0 text-muted-foreground">{t('端点')}</dt>
                        <dd className="min-w-0 truncate font-mono">{storage.endpoint}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-14 shrink-0 text-muted-foreground">{t('桶')}</dt>
                        <dd className="min-w-0 truncate font-mono">
                          {storage.bucket}
                          {storage.root ? `/${storage.root}` : ''}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-14 shrink-0 text-muted-foreground">{t('密钥')}</dt>
                        <dd className="min-w-0 truncate font-mono">
                          {storage.access_key} · {storage.secret_hint}
                        </dd>
                      </div>
                    </>
                  )}
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-muted-foreground">{t('文件数')}</dt>
                    <dd>{storage.file_count}</dd>
                  </div>
                </dl>

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  {storage.is_default ? null : (
                    <Can perm="sys:storage:edit">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={storage.status !== 1 || setDefault.isPending}
                        onClick={() => setPendingDefault(storage)}
                      >
                        <IconStar className="size-4" />
                        {t('设为默认')}
                      </Button>
                    </Can>
                  )}
                  {storage.builtin ? null : (
                    <Can perm="sys:storage:edit">
                      <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => void runTest(storage)}>
                        <IconPlugConnected className="size-4" />
                        {t('测试连接')}
                      </Button>
                      <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                        {t('启用')}
                        <Switch
                          checked={storage.status === 1}
                          disabled={setStatus.isPending}
                          onCheckedChange={(c) =>
                            void run(() => setStatus.mutateAsync({ id: storage.id, status: c ? 1 : 0 }))
                          }
                        />
                      </label>
                    </Can>
                  )}
                </div>
                {result ? (
                  <span
                    className={`flex items-center gap-1 text-xs ${result.ok ? 'text-emerald-600' : 'text-destructive'}`}
                  >
                    {result.ok ? <IconCheck className="size-3.5" /> : <IconX className="size-3.5" />}
                    {result.message}
                  </span>
                ) : null}
              </div>
            )
          })}

          <Can perm="sys:storage:add">
            <button
              type="button"
              onClick={() => {
                setEditing(null)
                setSheetOpen(true)
              }}
              className="flex min-h-48 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
            >
              <IconPlus className="size-5" />
              <span className="text-sm">{t('新增存储')}</span>
              {storages.length <= 1 ? (
                <span className="max-w-60 text-xs text-balance">
                  {t('多副本部署时请接一个对象存储（MinIO / 阿里 OSS / 腾讯 COS …），否则各台机器上的文件互不相通')}
                </span>
              ) : null}
            </button>
          </Can>
        </div>
      )}

      <StorageFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={pendingDefault !== null}
        onOpenChange={(o) => !o && setPendingDefault(null)}
        title={t('切换默认存储')}
        description={t('之后新上传的文件都会落到「{{name}}」。已有文件不搬家，仍从原来的存储读取。', {
          name: pendingDefault?.name ?? '',
        })}
        onConfirm={async () => {
          const target = pendingDefault
          setPendingDefault(null)
          if (target) await run(() => setDefault.mutateAsync(target.id))
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('删除存储')}
        destructive
        description={t('确定删除「{{name}}」？存储下还有文件时不能删除。', { name: pendingDelete?.name ?? '' })}
        onConfirm={async () => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) await run(() => del.mutateAsync(target.id))
        }}
      />
    </div>
  )
}
