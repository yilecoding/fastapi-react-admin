/**
 * 断点续传的本地记录：「这个文件已经开过一个分片会话，upload_id 是多少」。
 *
 * 刷新 / 关掉标签页之后 `File` 对象就没了，只能让用户重新选同一个文件 —— 靠指纹（名字 + 大小 + 修改时间）
 * 认出来，再去后端问那个会话还活着没有、传到哪几片了。会话本身在服务端（24 小时没动静就过期），
 * 这里只存一个指针，丢了也只是「从头传」，不会传错。
 *
 * localStorage 可能不可用（隐私模式 / 被禁），读写全部 try/catch，失败就当没有续传记录。
 */
export interface ResumeEntry {
  upload_id: string
  name: string
  size: number
  lastModified: number
  /** 浮窗里显示的来源（「文件管理」「附件」） */
  source?: string
  public?: boolean
  created_at: number
}

const KEY = 'admin:uploads:resume'
/** 和服务端会话的过期时间（FILE_MULTIPART_EXPIRE_SECONDS，默认 24h）对齐；过了就不必再去问 */
const MAX_AGE_MS = 24 * 3600 * 1000

export function fingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

function readAll(storage: Storage | undefined = globalThis.localStorage): Record<string, ResumeEntry> {
  try {
    const raw = storage?.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, ResumeEntry>) : {}
    const now = Date.now()
    for (const [fp, entry] of Object.entries(all)) {
      if (!entry || typeof entry.upload_id !== 'string' || now - entry.created_at > MAX_AGE_MS) delete all[fp]
    }
    return all
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, ResumeEntry>, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    if (Object.keys(all).length === 0) storage?.removeItem(KEY)
    else storage?.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 存不下就算了：最坏是刷新之后从头传 */
  }
}

export function createResumeStore(storage?: Storage) {
  return {
    get: (fp: string): ResumeEntry | undefined => readAll(storage)[fp],
    set: (fp: string, entry: ResumeEntry): void => writeAll({ ...readAll(storage), [fp]: entry }, storage),
    remove: (fp: string): void => {
      const all = readAll(storage)
      delete all[fp]
      writeAll(all, storage)
    },
    list: (): Array<[string, ResumeEntry]> => Object.entries(readAll(storage)),
  }
}

export type ResumeStore = ReturnType<typeof createResumeStore>
