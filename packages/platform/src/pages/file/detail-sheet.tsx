import { useTranslation } from 'react-i18next'
import { IconDownload, IconEye } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'

import { FILE_TYPE_LABEL, formatBytes, isPreviewable, type FileItem } from './api'
import { FileTypeIcon } from './file-icon'

/**
 * 文件详情。
 *
 * 宫格/列表都只显示「名字 + 体积」，其余元数据（落盘名 · 校验和 · MIME · 上传人）
 * 收到这里 —— 它们是排障字段，不该占掉每一屏的视觉预算。
 * 原来做成表格时这些是常驻列，结果最该看的文件名反而被挤窄了。
 */
export function FileDetailSheet({
  file,
  onOpenChange,
  onPreview,
  onDownload,
}: {
  file: FileItem | null
  onOpenChange: (open: boolean) => void
  onPreview: (f: FileItem) => void
  onDownload: (f: FileItem) => void
}) {
  const { t } = useTranslation()

  return (
    <Sheet open={file !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        {file && (
          <>
            <SheetHeader>
              <SheetTitle className="flex min-w-0 items-center gap-2 pe-6">
                <FileTypeIcon file={file} />
                <span className="min-w-0 truncate" title={file.original_name}>
                  {file.original_name}
                </span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-normal">
                  {t(FILE_TYPE_LABEL[file.type] ?? '其他')}
                </Badge>
                <span className="font-mono text-xs uppercase">{file.ext}</span>
                <span className="tabular-nums">{formatBytes(file.size)}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-2">
              <div className="flex gap-2">
                {isPreviewable(file) && (
                  <Button size="sm" onClick={() => onPreview(file)} data-testid="detail-preview">
                    <IconEye className="size-4" />
                    {t('预览')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDownload(file)}
                  data-testid="detail-download"
                >
                  <IconDownload className="size-4" />
                  {t('下载')}
                </Button>
              </div>

              <dl className="flex flex-col gap-3 text-sm">
                <Row label={t('原始文件名')} value={file.original_name} />
                <Row label={t('存储文件名')} value={file.name} mono />
                {/* 落盘按 YYYY/MM/DD 分目录，排障时要知道在哪一天那一格 */}
                <Row label={t('存储路径')} value={file.path} mono wrap />
                <Row label={t('MIME 类型')} value={file.content_type ?? '—'} mono />
                <Row label={t('字节数')} value={String(file.size)} mono />
                <Row label={t('上传时间')} value={file.created_time} mono />
                <Row label={t('上传人 ID')} value={file.created_by} mono />
                {/* 64 个 hex 必须能换行，否则会把抽屉横向撑破 */}
                <Row label={t('校验和')} value={file.sha256 ?? '—'} mono wrap />
              </dl>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Row({
  label,
  value,
  mono,
  wrap,
}: {
  label: string
  value: string
  mono?: boolean
  wrap?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={[
          'text-sm',
          mono ? 'font-mono text-xs' : '',
          wrap ? 'break-all' : 'truncate',
        ].join(' ')}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}
