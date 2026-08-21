import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconAlertTriangle, IconDownload } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@admin/ui/components/dialog'
import { Skeleton } from '@admin/ui/components/skeleton'
import { FileViewer } from '@admin/ui/components/file-viewer'

import { fileBytesQuery, formatBytes, isPreviewable, type FileItem } from './api'

/** 超过这个体积就先问一句再下载 —— 预览要把整个文件读进内存 */
const CONFIRM_OVER = 20 * 1024 * 1024

/**
 * 文件预览弹窗。
 *
 * 为什么是 Dialog 而不是页面内嵌一块区域：多页签用 `<Activity>` 保活，
 * 隐藏 tab 是 `display:none`（宽度 0），而 renderer 要测容器尺寸。
 * 弹窗只在活动页打开，天然避开这个问题。关闭即卸载（**不要** keepMounted），
 * 顺带把 ArrayBuffer 让给 GC。
 *
 * 数据流：`download_url`（带鉴权）→ `fetchBytes` → ArrayBuffer → viewer。
 * 不走公开直链 —— 后端那个无鉴权的 `/static/upload` 挂载已经撤掉了。
 */
export function FilePreviewDialog({
  file,
  onOpenChange,
  onDownload,
}: {
  file: FileItem | null
  onOpenChange: (open: boolean) => void
  onDownload: (file: FileItem) => void
}) {
  const { t } = useTranslation()
  // 大文件先确认再取字节。confirmed 跟着 file.id 走 ——
  // 换一个文件必须重新确认，否则一次同意会放过后面所有大文件
  const [confirmedId, setConfirmedId] = React.useState<string | null>(null)

  const previewable = file ? isPreviewable(file) : false
  const oversized = Boolean(file && file.size > CONFIRM_OVER)
  const needConfirm = oversized && file?.id !== confirmedId
  const shouldFetch = Boolean(file) && previewable && !needConfirm

  const { data, isPending, isError, error, refetch } = useQuery({
    ...fileBytesQuery(file ?? { id: '', download_url: '', size: 0 }),
    enabled: shouldFetch,
  })

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(o) => {
        if (!o) setConfirmedId(null)
        onOpenChange(o)
      }}
    >
      {/*
        ⚠️ 必须同时写 `max-w-*` 和 **`sm:max-w-*`**。
        DialogContent 的基础类是 `w-full max-w-[calc(100%-2rem)] … sm:max-w-md`：
        裸 `max-w-*` 能被 twMerge 消解掉前两条，但 `sm:max-w-md` 在**另一个变体作用域**，
        不算冲突、两条都会留在 class 里，于是 ≥sm 时弹窗被摁回 28rem
        —— 表现是「桌面端预览窗特别窄，手机端反而是对的」。
        这就是 CLAUDE.md「为什么有些覆盖有效、有些无声失效」那一节，仓库里已踩三次。
      */}
      <DialogContent
        className="flex h-[85vh] max-h-[85vh] w-[min(1120px,94vw)] max-w-[min(1120px,94vw)] flex-col gap-4 sm:max-w-[min(1120px,94vw)]"
        data-testid="file-preview-dialog"
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate" title={file?.original_name}>
              {file?.original_name}
            </span>
            {file && (
              <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* min-h-0 + min-w-0：没有它们，flex 项的自动最小尺寸会让内容把弹窗撑破
            （CLAUDE.md 里「min-width: auto 是横向溢出的元凶」那条的同款） */}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border bg-muted/30">
          {!file ? null : !previewable ? (
            <PreviewNotice
              icon={<IconAlertTriangle className="size-5 text-muted-foreground" />}
              title={t('{{ext}} 暂不支持预览', { ext: file.ext.toUpperCase() })}
              description={t('这个格式没有对应的预览器，可以下载后用本地软件打开。')}
              action={
                <Button size="sm" variant="outline" onClick={() => onDownload(file)}>
                  <IconDownload className="size-4" />
                  {t('下载')}
                </Button>
              }
            />
          ) : needConfirm ? (
            <PreviewNotice
              title={t('这个文件有 {{size}}', { size: formatBytes(file.size) })}
              description={t('预览需要先把整个文件下载到浏览器，确定继续吗？')}
              action={
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setConfirmedId(file.id)} data-testid="confirm-big-preview">
                    {t('继续预览')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onDownload(file)}>
                    <IconDownload className="size-4" />
                    {t('直接下载')}
                  </Button>
                </div>
              }
            />
          ) : isError ? (
            // 硬纪律 9：失败必须是可见状态 + 有重试入口，不能静默留空
            <PreviewNotice
              icon={<IconAlertTriangle className="size-5 text-destructive" />}
              title={t('文件加载失败')}
              description={error instanceof Error ? error.message : t('请稍后重试')}
              action={
                <Button size="sm" variant="outline" onClick={() => void refetch()} data-testid="retry-preview">
                  {t('重试')}
                </Button>
              }
            />
          ) : isPending || !data ? (
            <Skeleton className="size-full" data-testid="preview-loading" />
          ) : (
            <FileViewer buffer={data} filename={file.original_name} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PreviewNotice({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
      {icon}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}
