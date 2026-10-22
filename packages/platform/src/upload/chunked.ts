import { fingerprint, type ResumeStore } from './resume'

/** 服务端的分片会话（`/sys/files/multipart`） */
export interface MultipartSession {
  upload_id: string
  name: string
  size: number
  chunk_size: number
  total_parts: number
  uploaded_parts: number[]
}

/** 分片上传要用到的接口，由调用方注入（这一层不认识 api-client，好单测） */
export interface ChunkedApi<R> {
  init: (file: File, opts: { public?: boolean }) => Promise<MultipartSession>
  /** 会话不存在 / 过期 / 不是自己的 → null（服务端是 404） */
  status: (uploadId: string) => Promise<MultipartSession | null>
  putPart: (
    uploadId: string,
    part: number,
    blob: Blob,
    opts: { signal: AbortSignal; onProgress: (loaded: number) => void },
  ) => Promise<void>
  complete: (uploadId: string) => Promise<R>
  abort: (uploadId: string) => Promise<void>
}

export interface ChunkedOptions {
  signal: AbortSignal
  /** 整个文件已经送出去的字节（含续传前已有的那些） */
  onBytes: (loaded: number, total: number) => void
  /** 所有分片都传完、开始合并时调一次（浮窗显示「正在合并…」） */
  onFinalizing?: () => void
  resume?: ResumeStore
  /** 续传记录里带上的东西（来源、是否公开），刷新后浮窗要用 */
  meta?: { source?: string; public?: boolean }
  /** 同时传几片。3 是经验值：再多浏览器对同域名的连接数也就那么几个，只会互相抢 */
  concurrency?: number
  /** 单片失败重试几次（网络错误 / 5xx），4xx 不重试 */
  retries?: number
  /** 测试里把退避等待换成 0 */
  sleep?: (ms: number) => Promise<void>
}

/** 4xx（除了 408 / 429）是「这一片本身不对」，重试也不会好；其余（断网 = 0、5xx）值得再试 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  const status = (err as { httpStatus?: number } | null)?.httpStatus
  if (typeof status !== 'number') return true
  return status === 0 || status === 408 || status === 429 || status >= 500
}

/** 第 n 片（从 1 开始）的字节范围 */
export function partRange(n: number, chunk: number, size: number): [number, number] {
  return [(n - 1) * chunk, Math.min(n * chunk, size)]
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 分片上传一个文件：能续传就续传（同一个文件之前开过会话、而且会话还活着），并发传缺的那几片，最后 complete。
 *
 * - 用户**取消**（`signal` abort）= 放弃：删服务端会话、删续传记录
 * - **失败**（重试用尽）= 留着会话和续传记录，下次「重试」或刷新后重新选这个文件，从断的地方接着传
 */
export async function uploadChunked<R>(file: File, api: ChunkedApi<R>, opts: ChunkedOptions): Promise<R> {
  const { signal, resume } = opts
  const sleep = opts.sleep ?? defaultSleep
  const fp = fingerprint(file)

  let session: MultipartSession | null = null
  const known = resume?.get(fp)
  if (known) {
    session = await api.status(known.upload_id)
    // 会话还活着但对不上（服务端换了分片大小、文件被改过）就不续了，重开一个
    if (session && session.size !== file.size) session = null
    if (!session) resume?.remove(fp)
  }
  if (!session) {
    session = await api.init(file, { public: opts.meta?.public })
    resume?.set(fp, {
      upload_id: session.upload_id,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      source: opts.meta?.source,
      public: opts.meta?.public,
      created_at: Date.now(),
    })
  }
  const s = session

  const done = new Set(s.uploaded_parts)
  let doneBytes = 0
  for (const n of done) {
    const [a, b] = partRange(n, s.chunk_size, s.size)
    doneBytes += b - a
  }
  const inflight = new Map<number, number>()
  const report = () => {
    let sum = doneBytes
    for (const v of inflight.values()) sum += v
    opts.onBytes(Math.min(sum, s.size), s.size)
  }
  report()

  const queue: number[] = []
  for (let n = 1; n <= s.total_parts; n++) if (!done.has(n)) queue.push(n)

  const sendPart = async (n: number) => {
    const [a, b] = partRange(n, s.chunk_size, s.size)
    const blob = file.slice(a, b)
    const attempts = (opts.retries ?? 3) + 1
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new DOMException('upload aborted', 'AbortError')
      try {
        await api.putPart(s.upload_id, n, blob, {
          signal,
          onProgress: (loaded) => {
            inflight.set(n, loaded)
            report()
          },
        })
        inflight.delete(n)
        doneBytes += b - a
        report()
        return
      } catch (err) {
        inflight.delete(n)
        report()
        if (attempt >= attempts || !isRetryable(err) || signal.aborted) throw err
        // 指数退避：1s / 2s / 4s
        await sleep(1000 * 2 ** (attempt - 1))
      }
    }
  }

  try {
    const workers = Array.from({ length: Math.min(opts.concurrency ?? 3, queue.length) }, async () => {
      for (;;) {
        const n = queue.shift()
        if (n === undefined) return
        await sendPart(n)
      }
    })
    await Promise.all(workers)
    if (signal.aborted) throw new DOMException('upload aborted', 'AbortError')
    opts.onFinalizing?.()
    const result = await api.complete(s.upload_id)
    resume?.remove(fp)
    return result
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      // 取消 = 放弃：服务端的分片和会话一起清（失败了也无所谓，定时清理会兜底）
      resume?.remove(fp)
      await api.abort(s.upload_id).catch(() => {})
    }
    throw err
  }
}
