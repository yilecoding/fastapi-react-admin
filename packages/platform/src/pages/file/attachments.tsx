import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconDownload, IconEye, IconPaperclip, IconUpload, IconX } from '@tabler/icons-react'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { useFilePicker } from '@admin/ui/components/uploader/dropzone'

import { Can } from '../../auth/can'
import { fetchBytes } from '../../api-client/client'
import {
  formatBytes,
  isPreviewable,
  targetFilesQuery,
  useAttachFiles,
  useDetachFiles,
  type FileItem,
} from './api'
import { FilePreviewDialog } from './preview-dialog'
import { useFileUploader } from './uploader'
import { useUploadStore } from '../../shell/upload-store'

/**
 * 业务对象的附件面板。**任何页面都能直接嵌**，只要给 `targetType` + `targetId`。
 *
 * 这是 `sys_file_relation` 唯一的界面入口 —— 物理文件（`sys_file`）与
 * 「挂在谁身上」（关联）是两张表，所以这里的「移除」**只删关联、不删文件**：
 * 文件仍留在「文件管理」里，可以再挂到别处。真要删文件去文件管理页删，
 * 那边会连带清掉所有关联。
 *
 * `targetType` 是个约定字符串（`NOTICE` / `TICKET` / …），后端不做枚举校验 ——
 * 新业务挂附件不用改表也不用改后端，传个新值即可。代价是拼错了不会报错，
 * 只会读到空列表，所以**常量要写在调用方页面里**，别在 JSX 里手敲字面量。
 */
export function FileAttachments({
  targetType,
  targetId,
  className,
}: {
  targetType: string
  targetId: string
  className?: string
}) {
  const { t } = useTranslation()
  const { data, isPending, isError, error, refetch } = useQuery(targetFilesQuery(targetType, targetId))
  const files = data ?? []

  const attach = useAttachFiles()
  const detach = useDetachFiles()
  const [previewing, setPreviewing] = React.useState<FileItem | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  // 每个文件传完（含秒传命中）就立刻挂到目标上 —— 挂载是幂等的（后端跳过已挂的），
  // 所以重试、重复选同一个文件都不会挂出重复行
  const uploader = useFileUploader({
    source: t('附件'),
    onDone: (item) => {
      if (!item.result) return
      attach
        .mutateAsync({ file_ids: [item.result.id], target_type: targetType, target_id: targetId })
        .catch((e: unknown) => {
          // 上传成功但挂载失败：文件已经在文件管理里了，这里必须说清楚，
          // 否则用户以为整个操作失败、重传一次又多一份
          setActionError(
            t('文件已上传但挂载失败：{{err}}', { err: e instanceof Error ? e.message : t('未知错误') })
          )
        })
    },
  })
  const picker = useFilePicker({ onFiles: uploader.add })

  const busy = uploader.busy || attach.isPending || detach.isPending

  /**
   * 下载。不能做成 `<a href>` —— `download_url` 要 Authorization 头，
   * 裸链接带不上，结果是把 401 的 JSON 当文件存下来。
   */
  const handleDownload = React.useCallback(
    async (f: FileItem) => {
      setActionError(null)
      try {
        const buffer = await fetchBytes(f.download_url)
        const url = URL.createObjectURL(new Blob([buffer], { type: f.content_type ?? 'application/octet-stream' }))
        const a = document.createElement('a')
        a.href = url
        a.download = f.original_name
        a.click()
        URL.revokeObjectURL(url)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : t('下载失败'))
      }
    },
    [t]
  )


  const handleDetach = React.useCallback(
    async (f: FileItem) => {
      setActionError(null)
      try {
        await detach.mutateAsync({ file_ids: [f.id], target_type: targetType, target_id: targetId })
      } catch (e) {
        setActionError(e instanceof Error ? e.message : t('移除失败'))
      }
    },
    [detach, t, targetId, targetType]
  )

  return (
    <div className={className} data-testid="file-attachments">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <IconPaperclip className="size-4 text-muted-foreground" aria-hidden />
          {t('附件')}
          {files.length > 0 && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{files.length}</span>
          )}
        </p>
        <Can perm="sys:file:upload">
          <input {...picker.inputProps} data-testid="attach-input" />
          <Button size="sm" variant="outline" disabled={attach.isPending || detach.isPending} data-testid="attach-upload" onClick={picker.open}>
            <IconUpload className="size-4" />
            {uploader.busy ? t('上传中…') : t('添加附件')}
          </Button>
        </Can>
      </div>

      {uploader.pending > 0 && (
        /* 进度在右下角的浮窗里；这里只留一句，点一下把折叠的浮窗展开 */
        <button
          type="button"
          className="mt-2 w-full rounded-md border border-dashed px-3 py-1.5 text-start text-xs text-muted-foreground hover:bg-accent/40"
          onClick={() => useUploadStore.getState().setCollapsed(false)}
          data-testid="attach-uploading"
        >
          {t('{{n}} 个文件上传中，进度在右下角', { n: uploader.pending })}
        </button>
      )}

      {actionError && (
        <Alert tone="danger" data-testid="attach-error" className="mt-2 py-1.5 text-xs">
          {actionError}
        </Alert>
      )}

      <div className="mt-2">
        {isPending ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : isError ? (
          // 硬纪律 9：失败是可见状态 + 有重试入口，不能静默显示成「没有附件」
          <Alert
            tone="danger"
            className="py-2 text-xs"
            action={
              <Button size="sm" variant="outline" onClick={() => void refetch()} data-testid="attach-retry">
                {t('重试')}
              </Button>
            }
          >
            {error instanceof Error ? error.message : t('附件加载失败')}
          </Alert>
        ) : files.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {t('暂无附件')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="attach-list">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5"
                data-testid={`attach-item-${f.id}`}
              >
                <span className="min-w-0 flex-1 truncate text-sm" title={f.original_name}>
                  {f.original_name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatBytes(f.size)}
                </span>
                {isPreviewable(f) ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('预览 {{name}}', { name: f.original_name })}
                    data-testid={`attach-preview-${f.id}`}
                    onClick={() => setPreviewing(f)}
                  >
                    <IconEye className="size-4" />
                  </Button>
                ) : (
                  // 不能预览的不给按钮，但要说明原因 —— 直接不显示会让人以为坏了
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled
                          aria-label={t('{{ext}} 暂不支持预览，可下载后查看', { ext: f.ext.toUpperCase() })}
                        />
                      }
                    >
                      <IconEye className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('{{ext}} 暂不支持预览，可下载后查看', { ext: f.ext.toUpperCase() })}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('下载 {{name}}', { name: f.original_name })}
                  data-testid={`attach-download-${f.id}`}
                  onClick={() => void handleDownload(f)}
                >
                  <IconDownload className="size-4" />
                </Button>
                <Can perm="sys:file:upload">
                  {/* 「移除」只解开关联、不删文件，所以不加二次确认 ——
                      误点的代价是重新挂一次，而每次都弹确认框会把常规操作变成负担 */}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('移除 {{name}}', { name: f.original_name })}
                    data-testid={`attach-detach-${f.id}`}
                    onClick={() => void handleDetach(f)}
                  >
                    <IconX className="size-4" />
                  </Button>
                </Can>
              </li>
            ))}
          </ul>
        )}
      </div>

      <FilePreviewDialog
        file={previewing}
        onOpenChange={(o) => !o && setPreviewing(null)}
        onDownload={(f) => void handleDownload(f)}
      />
    </div>
  )
}
