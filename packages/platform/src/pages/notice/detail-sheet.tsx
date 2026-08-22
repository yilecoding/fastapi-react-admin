import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { RichTextViewer } from '@admin/ui/components/rich-text'
import { useTranslation } from 'react-i18next'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'

import { StatusPill } from '../_shared/status'
import { FileAttachments } from '../file/attachments'
import { NOTICE_ATTACHMENT_TARGET, NOTICE_TYPE_LABEL, type Notice } from './api'

/**
 * 全文查看。
 *
 * 列表里只放一行摘要（正文是 NVARCHAR(MAX)，塞进单元格会把行撑烂），
 * 点标题在这里看完整内容。正文按纯文本渲染 —— 后端存的就是纯文本，
 * 这里**不做 HTML 渲染**，否则等于把富文本 XSS 面开在管理端。
 */
export function NoticeDetailSheet({
  notice, onOpenChange,
}: {
  notice: Notice | null
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <Sheet open={notice !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl">
        {notice && (
          <>
            <SheetHeader>
              <SheetTitle className="pe-6" data-testid="notice-detail-title">{notice.title}</SheetTitle>
              {/* Base UI 走 `render` 而不是 `asChild`；SheetDescription 默认渲染成
                  <p>，里面塞 div 会成为非法嵌套，所以换成 span 容器 */}
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-normal">
                  {t(NOTICE_TYPE_LABEL[notice.type] ?? '—')}
                </Badge>
                {notice.status === 1 ? (
                  <StatusPill tone="success">{t('显示')}</StatusPill>
                ) : (
                  <StatusPill tone="muted">{t('隐藏')}</StatusPill>
                )}
                <span className="font-mono text-xs tabular-nums">
                  {t('创建 {{at}}', { at: formatDateTime(notice.created_time) })}
                  {notice.updated_time ? t(' · 更新 {{at}}', { at: formatDateTime(notice.updated_time) }) : ''}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-4 py-2">
              {/*
                正文是富文本 HTML。用 RichTextViewer 而不是 dangerouslySetInnerHTML：
                它走 Tiptap 的 schema 解析，schema 外的标签属性（script / onerror /
                javascript: 链接）在解析阶段就被丢掉，比事后过滤可靠。
              */}
              <RichTextViewer
                value={notice.content}
                data-testid="notice-detail-content"
              />

              {/*
                附件。`sys_file_relation` 的唯一界面入口 —— 这里的「移除」只解开关联，
                文件本身留在「文件管理」里。放在详情抽屉而不是编辑表单里，是因为
                挂载需要 `notice.id`，而新建表单在保存前还没有 id。
              */}
              <FileAttachments
                targetType={NOTICE_ATTACHMENT_TARGET}
                targetId={notice.id}
                className="mt-6"
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
