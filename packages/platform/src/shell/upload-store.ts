import { create } from 'zustand'

import { api, uploadBlob, uploadFile } from '../api-client/client'
import { tokenStore } from '../api-client/token-store'
import type { FileItem } from '../pages/file/api'
import {
  createResumeStore,
  createUploadQueue,
  fingerprint,
  sha256File,
  uploadChunked,
  type ChunkedApi,
  type MultipartSession,
  type ResumeEntry,
  type UploadItem,
  type UploadItemOptions,
} from '../upload'

/**
 * 全局上传队列 + 右下角浮窗的状态。
 *
 * 队列活在这里而不是页面组件里：关掉「文件管理」页签上传不会被取消，切到别的页面也看得见进度
 * （浮窗挂在壳层，页签之外）。文件页 / 附件面板 / 富文本都往同一个队列 `enqueue`，
 * 各自的收尾（附件面板的「挂载」）跟着那一项走（`opts.onDone`），面板关了也照常执行。
 *
 * 每个文件：浏览器端 sha256 → `/check` 秒传预检 → 小文件一次 `/upload`（XHR），
 * 大文件（≥ 服务端下发的 `chunk_threshold`）走分片：`/multipart` init → 并发 PUT 各片 → complete。
 * 分片会话的 upload_id 记在 localStorage（`upload/resume.ts`）：失败了「重试」、刷新后重新选同一个文件，
 * 都从断的地方接着传。列表刷新由浮窗组件在挂载时注入（store 里没有 queryClient）。
 */
type Invalidate = () => void

/** 刷新前没传完、还能接着传的分片上传（浮窗里显示「重新选择文件继续」） */
export type ResumableUpload = { fp: string; entry: ResumeEntry; progress: number }

type UploadTrayState = {
  items: readonly UploadItem<FileItem>[]
  resumable: readonly ResumableUpload[]
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
  /** 浮窗挂载时注入「刷新文件列表」，顺便去服务端核一遍还能续传的会话 */
  bind: (invalidate: Invalidate) => void
  /** 用重新选的文件接着传；不是同一个文件（指纹对不上）返回 false */
  continueResumable: (fp: string, file: File) => boolean
  /** 放弃一个没传完的：删服务端会话和分片 */
  discardResumable: (fp: string) => void
  /** 会话结束 / 换人时清理内存状态；各用户的续传记录保留。 */
  reset: () => void
}

let invalidateFiles: Invalidate = () => {}
let generation = 0
let binding: AbortController | null = null

function currentResumeStore() {
  const userId = tokenStore.getUserId()
  return userId ? createResumeStore(userId) : null
}

type Policy = { chunk_threshold: number; chunk_size: number }
let policy: Promise<Policy> | null = null
let policyAt = 0
/**
 * 一批文件共用一次取到的策略，过了这么久就重取。
 * 原来是「一个页面会话取一次」—— 而阈值现在能在参数配置页改（#139），管理员改完回文件页传一个试试，
 * 拿到的还是改之前那份，看起来像「改了没生效」
 */
const POLICY_TTL_MS = 10_000
/** 分片阈值由服务端下发（参数配置「文件上传」组，`.env` 是默认值）；取失败就当「不分片」，下次再取 */
function getPolicy(signal: AbortSignal): Promise<Policy> {
  if (!policy || Date.now() - policyAt > POLICY_TTL_MS) {
    policyAt = Date.now()
    const requested = api.GET<Policy>('/api/v1/sys/files/upload-policy', { signal }).catch(() => {
      if (policy === requested) policy = null
      return { chunk_threshold: Number.POSITIVE_INFINITY, chunk_size: 0 }
    })
    policy = requested
  }
  return policy
}

const MP = '/api/v1/sys/files/multipart'

/** 会话不存在 / 过期 / 不是自己的，服务端一律 404 —— 对续传来说就是「没有」 */
async function sessionOrNull(uploadId: string, signal?: AbortSignal): Promise<MultipartSession | null> {
  try {
    return await api.GET<MultipartSession>(`${MP}/${uploadId}`, { signal })
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus === 404) return null
    throw err
  }
}

function chunkedApiFor(signal: AbortSignal): ChunkedApi<FileItem> {
  const started = generation
  const owner = tokenStore.getUserId()
  const current = () => started === generation && owner === tokenStore.getUserId()
  const check = () => {
    signal.throwIfAborted()
    if (!current()) throw new DOMException('session ended', 'AbortError')
  }
  return {
    init: (file, { public: isPublic }) => {
      check()
      return api.POST<MultipartSession>(MP, {
        body: { name: file.name, size: file.size, public: isPublic ?? false },
        signal,
      })
    },
    status: (uploadId) => {
      check()
      return sessionOrNull(uploadId, signal)
    },
    putPart: (uploadId, part, blob, opts) => {
      check()
      return uploadBlob<unknown>(`${MP}/${uploadId}/${part}`, blob, opts).then(() => undefined)
    },
    complete: (uploadId) => {
      check()
      return api.POST<FileItem>(`${MP}/${uploadId}/complete`, { signal })
    },
    // 取消后的清理可能在下一位用户登录后才运行；不能借用新账号的 token 删除旧会话。
    abort: (uploadId) => (current() ? api.DELETE(`${MP}/${uploadId}`).then(() => undefined) : Promise.resolve()),
  }
}

const queue = createUploadQueue<FileItem>(
  {
    hash: (file, ctx) => sha256File(file, { signal: ctx.signal, onProgress: ctx.onProgress }),
    check: async (file, sha256, signal, opts) => {
      const params = new URLSearchParams({ sha256, name: file.name })
      if (opts.public) params.set('public', 'true')
      // 「没传过」是 data: null（success），不是 fail —— 首次上传不是错误
      return api.GET<FileItem | null>(`/api/v1/sys/files/check?${params.toString()}`, { signal })
    },
    upload: async (file, ctx, opts) => {
      ctx.signal.throwIfAborted()
      const resume = currentResumeStore()
      const { chunk_threshold } = await getPolicy(ctx.signal)
      ctx.signal.throwIfAborted()
      if (file.size >= chunk_threshold) {
        return uploadChunked<FileItem>(file, chunkedApiFor(ctx.signal), {
          signal: ctx.signal,
          onBytes: ctx.onBytes,
          onFinalizing: ctx.onFinalizing,
          resume: resume ?? undefined,
          meta: { source: opts.source, public: opts.public },
        })
      }
      return uploadFile<FileItem>(`/api/v1/sys/files/upload${opts.public ? '?public=true' : ''}`, file, 'file', {
        signal: ctx.signal,
        onProgress: ctx.onBytes,
      })
    },
  },
  { onDone: () => invalidateFiles() },
)

export const useUploadStore = create<UploadTrayState>()((set, get) => {
  queue.subscribe(() => set({ items: queue.getItems() }))

  const dropResumable = (fp: string) => set({ resumable: get().resumable.filter((r) => r.fp !== fp) })

  return {
    items: queue.getItems(),
    resumable: [],
    open: false,
    collapsed: false,
    enqueue: (files, opts) => {
      if (!tokenStore.getUserId()) return
      const list = Array.from(files)
      // 重新选的正好是一个「没传完的」：它会自己续上，浮窗里那一行可以撤了
      for (const f of list) dropResumable(fingerprint(f))
      const added = queue.add(list, opts)
      // 一有文件入队就弹出（展开态）：用户要看到它开始了
      if (added.length) set({ open: true, collapsed: false })
    },
    cancel: queue.cancel,
    retry: queue.retry,
    remove: queue.remove,
    cancelAll: () => {
      for (const it of queue.getItems())
        if (it.status !== 'done' && it.status !== 'failed' && it.status !== 'canceled') queue.cancel(it.id)
    },
    clearFinished: queue.clear,
    setCollapsed: (v) => set({ collapsed: v }),
    close: () => {
      for (const it of queue.getItems()) queue.remove(it.id)
      set({ open: false, collapsed: false })
    },
    bind: (fn) => {
      binding?.abort()
      const controller = (binding = new AbortController())
      const started = generation
      const resume = currentResumeStore()
      const current = () => started === generation && !controller.signal.aborted
      invalidateFiles = fn
      if (!resume) return
      // 去服务端核一遍 localStorage 里那些还能不能续：过期的（404）直接丢掉，活着的显示出来
      void (async () => {
        const found: ResumableUpload[] = []
        for (const [fp, entry] of resume.list()) {
          if (!current()) return
          const session = await sessionOrNull(entry.upload_id, controller.signal).catch(() => undefined)
          if (!current()) return
          if (session === null) {
            resume.remove(fp)
            continue
          }
          if (session === undefined) continue // 网络问题：这次不显示，也别删
          let sent = 0
          for (const n of session.uploaded_parts)
            sent += Math.min(session.chunk_size, session.size - (n - 1) * session.chunk_size)
          found.push({ fp, entry, progress: session.size > 0 ? sent / session.size : 0 })
        }
        if (found.length) set({ resumable: found, open: true })
      })()
    },
    continueResumable: (fp, file) => {
      const target = get().resumable.find((r) => r.fp === fp)
      if (!target || fingerprint(file) !== fp) return false
      get().enqueue([file], { source: target.entry.source, public: target.entry.public })
      return true
    },
    discardResumable: (fp) => {
      const target = get().resumable.find((r) => r.fp === fp)
      dropResumable(fp)
      currentResumeStore()?.remove(fp)
      if (target) void api.DELETE(`${MP}/${target.entry.upload_id}`).catch(() => {})
    },
    reset: () => {
      generation++
      binding?.abort()
      binding = null
      invalidateFiles = () => {}
      policy = null
      policyAt = 0
      queue.reset()
      set({ items: [], resumable: [], open: false, collapsed: false })
    },
  }
})

// 包括 401 会话失效以及静默恢复为另一身份；不只依赖显式 logout 的调用方。
tokenStore.subscribeIdentity(() => useUploadStore.getState().reset())
