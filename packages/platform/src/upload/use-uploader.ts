import * as React from 'react'

import { createUploadQueue, isActive, type UploadQueue } from './queue'
import type { UploadHooks, UploadItem, UploadTransport } from './types'

export interface Uploader<R> {
  items: readonly UploadItem<R>[]
  /** 有文件在传 / 在算 / 在排队 */
  busy: boolean
  add: (files: Iterable<File> | FileList | null | undefined) => void
  cancel: (id: string) => void
  retry: (id: string) => void
  remove: (id: string) => void
  clear: () => void
}

/**
 * 把一个上传队列接进 React。队列活到组件卸载；`transport` / `hooks` 每次渲染取最新的
 * （放 ref 里），所以调用方不用 useCallback 包回调。
 */
export function useUploader<R>(transport: UploadTransport<R>, hooks: UploadHooks<R> = {}): Uploader<R> {
  const transportRef = React.useRef(transport)
  const hooksRef = React.useRef(hooks)
  transportRef.current = transport
  hooksRef.current = hooks

  const queueRef = React.useRef<UploadQueue<R> | null>(null)
  if (queueRef.current === null) {
    queueRef.current = createUploadQueue<R>(
      {
        hash: transport.hash ? (file, ctx) => transportRef.current.hash!(file, ctx) : undefined,
        check: transport.check ? (file, sha, signal) => transportRef.current.check!(file, sha, signal) : undefined,
        upload: (file, ctx) => transportRef.current.upload(file, ctx),
      },
      {
        onDone: (item) => hooksRef.current.onDone?.(item),
        onError: (item) => hooksRef.current.onError?.(item),
      },
    )
  }
  const queue = queueRef.current

  // 卸载时取消进行中的：页面切走了（多页签是 <Activity> 保活，不会卸载；真卸载是关掉 tab）
  React.useEffect(() => () => queue.destroy(), [queue])

  const items = React.useSyncExternalStore(queue.subscribe, queue.getItems, queue.getItems)

  return React.useMemo(
    () => ({
      items,
      busy: items.some((it) => it.status === 'queued' || isActive(it)),
      add: (files) => {
        if (files) queue.add(Array.from(files))
      },
      cancel: queue.cancel,
      retry: queue.retry,
      remove: queue.remove,
      clear: queue.clear,
    }),
    [items, queue],
  )
}
