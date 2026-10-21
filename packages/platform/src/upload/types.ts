/**
 * 上传队列的数据形状。`ui/components/uploader` 只认这一个形状渲染（结构上兼容，ui 不 import 这里）。
 */
export type UploadStatus =
  | 'queued' // 排队，还没轮到
  | 'hashing' // 浏览器端算 sha256（秒传预检要用）
  | 'checking' // 问后端「这份内容传过吗」
  | 'uploading' // 真正在传
  | 'done' // 成功（含秒传命中）
  | 'failed' // 失败，可重试
  | 'canceled' // 用户取消，可重试

export interface UploadItem<R = unknown> {
  id: string
  file: File
  name: string
  size: number
  status: UploadStatus
  /** 0 ~ 1。hashing / uploading 两个阶段各自从 0 走到 1 */
  progress: number
  /** 已发送字节数（只在 uploading 阶段有意义） */
  loaded: number
  /** 字节 / 秒，uploading 阶段的滑动平均；拿不到时 null */
  speed: number | null
  error: string | null
  /** 后端返回的记录（文件详情之类） */
  result: R | null
  /** 秒传命中：没传一个字节，直接复用了已有记录 */
  reused: boolean
}

/** 一个真正会动的阶段的信号 */
export interface StepContext {
  signal: AbortSignal
  onProgress: (fraction: number) => void
}

/**
 * 队列不知道任何接口，三步全由调用方注入：
 * `hash` + `check` 都给了才做秒传预检；只给 `upload` 就是最朴素的「排队传」。
 */
export interface UploadTransport<R> {
  hash?: (file: File, ctx: StepContext) => Promise<string>
  /** 返回已有记录 = 秒传命中；null = 没传过 */
  check?: (file: File, sha256: string, signal: AbortSignal) => Promise<R | null>
  upload: (file: File, ctx: StepContext & { onBytes: (loaded: number, total: number) => void }) => Promise<R>
}

export interface UploadHooks<R> {
  onDone?: (item: UploadItem<R>) => void
  onError?: (item: UploadItem<R>) => void
}
