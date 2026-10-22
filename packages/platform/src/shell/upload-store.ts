import { create } from 'zustand'

import { api, uploadFile } from '../api-client/client'
import type { FileItem } from '../pages/file/api'
import { createUploadQueue, sha256File, type UploadItem, type UploadItemOptions } from '../upload'

/**
 * 全局上传队列 + 右下角浮窗的状态。
 *
 * 队列活在这里而不是页面组件里：关掉「文件管理」页签上传不会被取消，切到别的页面也看得见进度
 * （浮窗挂在壳层，页签之外）。文件页 / 附件面板 / 富文本都往同一个队列 `enqueue`，
 * 各自的收尾（附件面板的「挂载」）跟着那一项走（`opts.onDone`），面板关了也照常执行。
 *
 * 传输三步同 `pages/file/uploader.ts` 原来那份：浏览器端 sha256 → `/check` 秒传预检 → `/upload`（XHR）。
 * 列表刷新由浮窗组件在挂载时注入（store 里没有 queryClient）。
 */
type Invalidate = () => void

type UploadTrayState = {
  items: readonly UploadItem<FileItem>[]
  /** 浮窗是否显示（有文件入队就显示，用户关掉才消失） */
  open: boolean
  collapsed: boolean
  enqueue: (files: Iterable<File>, opts?: UploadItemOptions<FileItem>) => void
  cancel: (id: string) => void
  retry: (id: string) => void
  remove: (id: string) => void
  cancelAll: () => void
  clearFinished: () => void
  setCollapsed: (v: boolean) => void
  /** 关浮窗。调用方要先确认过「取消全部」—— 这里会把进行中的都取消掉 */
  close: () => void
  /** 浮窗挂载时注入「刷新文件列表」 */
  bind: (invalidate: Invalidate) => void
}

let invalidateFiles: Invalidate = () => {}

const queue = createUploadQueue<FileItem>(
  {
    hash: (file, ctx) => sha256File(file, { signal: ctx.signal, onProgress: ctx.onProgress }),
    check: async (file, sha256, _signal, opts) => {
      const params = new URLSearchParams({ sha256, name: file.name })
      if (opts.public) params.set('public', 'true')
      // 「没传过」是 data: null（success），不是 fail —— 首次上传不是错误
      return api.GET<FileItem | null>(`/api/v1/sys/files/check?${params.toString()}`)
    },
    upload: (file, ctx, opts) =>
      uploadFile<FileItem>(`/api/v1/sys/files/upload${opts.public ? '?public=true' : ''}`, file, 'file', {
        signal: ctx.signal,
        onProgress: ctx.onBytes,
      }),
  },
  { onDone: () => invalidateFiles() },
)

export const useUploadStore = create<UploadTrayState>()((set) => {
  queue.subscribe(() => set({ items: queue.getItems() }))
  return {
    items: queue.getItems(),
    open: false,
    collapsed: false,
    enqueue: (files, opts) => {
      const added = queue.add(Array.from(files), opts)
      // 一有文件入队就弹出（展开态）：用户要看到它开始了
      if (added.length) set({ open: true, collapsed: false })
    },
    cancel: queue.cancel,
    retry: queue.retry,
    remove: queue.remove,
    cancelAll: () => {
      for (const it of queue.getItems()) if (it.status !== 'done' && it.status !== 'failed' && it.status !== 'canceled') queue.cancel(it.id)
    },
    clearFinished: queue.clear,
    setCollapsed: (v) => set({ collapsed: v }),
    close: () => {
      for (const it of queue.getItems()) queue.remove(it.id)
      set({ open: false, collapsed: false })
    },
    bind: (fn) => {
      invalidateFiles = fn
    },
  }
})
