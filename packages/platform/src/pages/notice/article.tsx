import { RichTextViewer } from '@admin/ui/components/rich-text'

import { FileAttachments } from '../file/attachments'
import { NOTICE_ATTACHMENT_TARGET } from './api'

/**
 * 公告的「正文 + 附件」那一段。读者详情（`reader-sheet.tsx`）和管理页的「查看」抽屉
 * （`detail-sheet.tsx`）共用这一份 —— 管理员在「查看」里看到的，就是读者会看到的。
 *
 * - 正文用 `RichTextViewer` 而不是 `dangerouslySetInnerHTML`：它走 Tiptap 的 schema 解析，
 *   schema 外的标签属性（script / onerror / javascript: 链接）在解析阶段就被丢掉
 * - 附件**只读**：挂 / 摘附件挪进了新增 / 编辑表单（#186，附件和公告同一个事务提交）。
 *   这里就算看的人有 `sys:file:upload` 也不出「添加 / 移除」
 * - 预览走 `FileAttachments` 里现成的预览弹窗，不在抽屉里直接嵌 —— 预览器要量容器尺寸，
 *   只能挂在 Dialog 里（[file 分册](../file/AGENTS.md)「只在可见处挂载」）
 */
export function NoticeArticle({
  id,
  content,
  hideEmptyAttachments = false,
  attachmentCount,
}: {
  id: string
  content: string
  /** 读者不需要看到「暂无附件」；管理端留着它，好确认「确实没挂上」 */
  hideEmptyAttachments?: boolean
  /**
   * 详情接口一起带回来的附件个数（读者那份有）。确定是 0 就连附件列表都不取 ——
   * 不然没附件的公告每次打开都先闪一下「附件」标题 + 骨架行再消失
   */
  attachmentCount?: number
}) {
  const skip = hideEmptyAttachments && attachmentCount === 0
  return (
    <>
      <RichTextViewer value={content} data-testid="notice-content" />
      {!skip && (
        <FileAttachments
          targetType={NOTICE_ATTACHMENT_TARGET}
          targetId={id}
          readOnly
          hideWhenEmpty={hideEmptyAttachments}
          className="mt-6 border-t pt-4"
        />
      )}
    </>
  )
}
