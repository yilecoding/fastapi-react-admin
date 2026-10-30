import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { useTranslation } from 'react-i18next'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'

import { StatusPill } from '../_shared/status'
import { NOTICE_TYPE_LABEL, isExpired, type Notice } from './api'
import { NoticeArticle } from './article'
import { NoticeLevelPill, PinnedMark } from './shared'

/**
 * 管理页的「查看」抽屉。
 *
 * 列表里只放一行摘要（正文是 NVARCHAR(MAX)，塞进单元格会把行撑烂），点标题在这里看全文。
 * 数据就是列表那一行（管理端接口带正文），所以隐藏 / 过期的也看得到 ——
 * 读者那份（`reader-sheet.tsx`）走 `/feed`，看不到这两种。
 *
 * 正文 + 附件那一段和读者共用 `NoticeArticle`：**附件在这里是只读的**，
 * 挂 / 摘附件挪进了新增 / 编辑表单（#186：原来要先保存、再来这里传，
 * 而状态默认「显示」，一保存就发了广播 —— 读者收到通知时附件还没挂上）。
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
                {isExpired(notice.expire_time) && <StatusPill tone="muted">{t('已过期')}</StatusPill>}
                <NoticeLevelPill level={notice.level} />
                {notice.pinned && <PinnedMark withLabel />}
                <span className="font-mono text-xs tabular-nums">
                  {t('创建 {{at}}', { at: formatDateTime(notice.created_time) })}
                  {notice.updated_time ? t(' · 更新 {{at}}', { at: formatDateTime(notice.updated_time) }) : ''}
                  {notice.expire_time ? t(' · {{at}} 过期', { at: formatDateTime(notice.expire_time) }) : ''}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2">
              <NoticeArticle id={notice.id} content={notice.content} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
