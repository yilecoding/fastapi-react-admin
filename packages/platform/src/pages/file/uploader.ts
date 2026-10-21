import { traySummary, type UploadItem } from '../../upload'
import { useUploadStore } from '../../shell/upload-store'
import type { FileItem } from './api'

/**
 * 文件管理 / 附件面板的上传入口：往**全局**队列塞文件（`shell/upload-store.ts`），
 * 进度在右下角的浮窗里（`shell/upload-tray.tsx`），页面自己不画队列。
 *
 * 队列不在页面里的理由：关掉「文件管理」页签上传不会被取消，切到别的页面也看得见进度；
 * 附件面板的「传完就挂载」跟着那一项走（`onDone` 存在队列里），面板关了也照常执行。
 *
 * ⚠️ `public` 只给富文本内联图那条路；文件页和附件面板都不传。
 */
export function useFileUploader(options: {
  /** 浮窗里每行显示的来源（「文件管理」「附件」） */
  source: string
  public?: boolean
  onDone?: (item: UploadItem<FileItem>) => void
}) {
  const enqueue = useUploadStore((s) => s.enqueue)
  const items = useUploadStore((s) => s.items)
  const mine = traySummary(items.filter((it) => it.opts.source === options.source))
  return {
    add: (files: Iterable<File> | FileList | null | undefined) => {
      if (files) enqueue(Array.from(files), { source: options.source, public: options.public, onDone: options.onDone })
    },
    /** 这个来源有文件在传 / 在排队 */
    busy: mine.busy,
    /** 这个来源在传 + 在排队的个数 */
    pending: mine.active + mine.queued,
  }
}
