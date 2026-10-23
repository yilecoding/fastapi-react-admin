import type { StepContext, UploadHooks, UploadItem, UploadItemOptions, UploadTransport } from './types'

/**
 * 上传队列：headless 的状态机，不渲染、不知道接口。
 *
 * 一个文件的生命周期：queued → hashing → checking → uploading → done | failed | canceled。
 * **串行**处理（同一时刻只有一个文件在传）—— 并发上传会同时命中后端「整个 body 先收完才校验大小」
 * 那条，几个大文件一起来会把服务端内存顶起来（`file_ops.py` 的注释里写了）。
 * 秒传命中（`check` 返回了记录）直接 done，一个字节都不传。
 *
 * 用 `useUploader()` 接进 React；这里保持纯 TS，好单测。
 */
export interface UploadQueue<R> {
  getItems: () => readonly UploadItem<R>[]
  subscribe: (listener: () => void) => () => void
  add: (files: Iterable<File>, opts?: UploadItemOptions<R>) => UploadItem<R>[]
  cancel: (id: string) => void
  retry: (id: string) => void
  remove: (id: string) => void
  /** 清掉所有已结束的（done / failed / canceled），进行中的留着 */
  clear: () => void
  /** 取消进行中的、丢掉全部 */
  destroy: () => void
}

const ACTIVE: ReadonlySet<UploadItem['status']> = new Set(['hashing', 'checking', 'uploading', 'finalizing'])

export function isActive(item: Pick<UploadItem, 'status'>): boolean {
  return ACTIVE.has(item.status)
}

let seq = 0

export function createUploadQueue<R>(transport: UploadTransport<R>, hooks: UploadHooks<R> = {}): UploadQueue<R> {
  let items: UploadItem<R>[] = []
  const listeners = new Set<() => void>()
  const controllers = new Map<string, AbortController>()
  let running = false

  const emit = () => {
    for (const fn of listeners) fn()
  }
  const patch = (id: string, changes: Partial<UploadItem<R>>) => {
    items = items.map((it) => (it.id === id ? { ...it, ...changes } : it))
    emit()
  }
  const get = (id: string) => items.find((it) => it.id === id)

  const finish = (id: string) => {
    const done = get(id)!
    // 先这一项自己的回调（附件面板的「挂载」），再全局的（刷新列表）
    done.opts.onDone?.(done)
    hooks.onDone?.(done)
  }

  async function run(item: UploadItem<R>): Promise<void> {
    const controller = new AbortController()
    controllers.set(item.id, controller)
    const { signal } = controller
    const step = (status: UploadItem['status']): StepContext => {
      patch(item.id, { status, progress: 0, loaded: 0, speed: null, error: null })
      return { signal, onProgress: (fraction) => patch(item.id, { progress: Math.max(0, Math.min(1, fraction)) }) }
    }

    try {
      let sha256: string | null = null
      if (transport.hash && transport.check) {
        sha256 = await transport.hash(item.file, step('hashing'))
        patch(item.id, { status: 'checking', progress: 0 })
        const existing = await transport.check(item.file, sha256, signal, item.opts)
        if (existing !== null) {
          patch(item.id, { status: 'done', progress: 1, loaded: item.size, result: existing, reused: true })
          finish(item.id)
          return
        }
      }

      const ctx = step('uploading')
      // 速度：按进度事件算滑动平均（EMA），抖动小一点；第一个事件前是 null
      let lastAt = Date.now()
      let lastLoaded = 0
      let speed: number | null = null
      const result = await transport.upload(
        item.file,
        {
          ...ctx,
          onBytes: (loaded, total) => {
          const now = Date.now()
          const dt = (now - lastAt) / 1000
          if (dt >= 0.25) {
            const instant = (loaded - lastLoaded) / dt
            speed = speed === null ? instant : speed * 0.6 + instant * 0.4
            lastAt = now
            lastLoaded = loaded
          }
            patch(item.id, { loaded, progress: total > 0 ? loaded / total : 0, speed })
          },
          onFinalizing: () => patch(item.id, { status: 'finalizing', progress: 1, speed: null }),
        },
        item.opts,
      )
      patch(item.id, { status: 'done', progress: 1, loaded: item.size, speed: null, result })
      finish(item.id)
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        patch(item.id, { status: 'canceled', speed: null })
        return
      }
      patch(item.id, { status: 'failed', speed: null, error: err instanceof Error ? err.message : String(err) })
      const failed = get(item.id)!
      failed.opts.onError?.(failed)
      hooks.onError?.(failed)
    } finally {
      controllers.delete(item.id)
    }
  }

  async function pump(): Promise<void> {
    if (running) return
    running = true
    try {
      for (;;) {
        const next = items.find((it) => it.status === 'queued')
        if (!next) break
        await run(next)
      }
    } finally {
      running = false
    }
  }

  return {
    getItems: () => items,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    add: (files, opts = {}) => {
      const added: UploadItem<R>[] = []
      for (const file of files) {
        added.push({
          id: `u${++seq}`,
          file,
          opts,
          name: file.name,
          size: file.size,
          status: 'queued',
          progress: 0,
          loaded: 0,
          speed: null,
          error: null,
          result: null,
          reused: false,
        })
      }
      if (added.length === 0) return added
      items = [...items, ...added]
      emit()
      void pump()
      return added
    },
    cancel: (id) => {
      const item = get(id)
      if (!item) return
      if (item.status === 'queued') {
        patch(id, { status: 'canceled' })
        return
      }
      controllers.get(id)?.abort()
    },
    retry: (id) => {
      const item = get(id)
      if (!item || (item.status !== 'failed' && item.status !== 'canceled')) return
      patch(id, { status: 'queued', progress: 0, loaded: 0, speed: null, error: null, result: null, reused: false })
      void pump()
    },
    remove: (id) => {
      const item = get(id)
      if (!item) return
      if (isActive(item)) controllers.get(id)?.abort()
      items = items.filter((it) => it.id !== id)
      emit()
    },
    clear: () => {
      items = items.filter((it) => it.status === 'queued' || isActive(it))
      emit()
    },
    destroy: () => {
      for (const c of controllers.values()) c.abort()
      items = []
      listeners.clear()
    },
  }
}
