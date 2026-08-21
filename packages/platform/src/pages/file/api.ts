import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, fetchBytes, uploadFile, type PageData } from '../../api-client/client'

/**
 * 文件管理。
 *
 * ⚠️ id / created_by 都是雪花字符串，不要 `Number()`（CLAUDE.md 硬纪律 6）。
 * 后端 `stringify_unsafe_ints` 会把超过 2^53 的整数下发成字符串，
 * schema 里也已经声明成 `string | number`，这里统一按 string 用。
 */
export type FileType = 'image' | 'document' | 'video' | 'audio' | 'archive' | 'other'

export type FileItem = {
  id: string
  /** 落盘名（带随机后缀），列表里不展示，删除/排障时有用 */
  name: string
  /** 相对存储路径，含 `YYYY/MM/DD` 日期目录 */
  path: string
  /** 原始文件名，界面上显示这个 */
  original_name: string
  ext: string
  content_type: string | null
  size: number
  sha256: string | null
  type: FileType
  created_by: string
  created_time: string
  updated_time: string | null
  /** 带鉴权的下载/预览地址，由后端拼好 */
  download_url: string
  /** 落在公开子树（不鉴权可读）。只有富文本内联图会是 true */
  is_public: boolean
  /**
   * 无鉴权直链，**只有 `is_public` 的文件有**，私有文件是 `null`。
   *
   * 后端刻意不让它回落到 `download_url`：那个地址要 Authorization 头，
   * 塞进 `<img src>` 只会拿到 401。`null` 是明确的「这个文件没有直链」。
   */
  public_url: string | null
}

export type FileListParams = {
  page: number
  size: number
  name?: string
  type?: FileType
  ext?: string
  start_time?: string
  end_time?: string
}

export const fileKeys = {
  all: ['sys', 'file'] as const,
  list: (p: FileListParams) => [...fileKeys.all, 'list', p] as const,
  statistics: () => [...fileKeys.all, 'statistics'] as const,
  target: (targetType: string, targetId: string) => [...fileKeys.all, 'target', targetType, targetId] as const,
}

function qs(p: FileListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.name) s.set('name', p.name)
  if (p.type) s.set('type', p.type)
  if (p.ext) s.set('ext', p.ext)
  if (p.start_time) s.set('start_time', p.start_time)
  if (p.end_time) s.set('end_time', p.end_time)
  return s.toString()
}

export const filesQuery = (p: FileListParams) =>
  queryOptions({
    queryKey: fileKeys.list(p),
    queryFn: () => api.GET<PageData<FileItem>>(`/api/v1/sys/files?${qs(p)}`),
    // 翻页时保留上一页，避免表格闪空
    placeholderData: (prev) => prev,
  })

export type FileStatistics = {
  total_count: number
  total_size: number
  type_counts: Partial<Record<FileType, number>>
  type_sizes: Partial<Record<FileType, number>>
}

export const fileStatisticsQuery = () =>
  queryOptions({
    queryKey: fileKeys.statistics(),
    queryFn: () => api.GET<FileStatistics>('/api/v1/sys/files/statistics'),
  })

/** 某个业务对象挂着的附件（顺序由后端的关联表 sort 决定，不要在前端重排） */
export const targetFilesQuery = (targetType: string, targetId: string) =>
  queryOptions({
    queryKey: fileKeys.target(targetType, targetId),
    queryFn: () => api.GET<FileItem[]>(`/api/v1/sys/files/targets/${targetType}/${targetId}`),
  })

export function useUploadFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => uploadFile<FileItem>('/api/v1/sys/files/upload', file),
    onSuccess: () => qc.invalidateQueries({ queryKey: fileKeys.all }),
  })
}

/**
 * 富文本正文里内联图的体积上限。
 *
 * 服务端才是权威（`UPLOAD_IMAGE_SIZE_MAX` 默认 5MB，而且会被 `sys_config`
 * 在运行时 `setattr` 覆盖），这里压到 2MB 只为两件事：别把注定被拒的字节
 * 先传一遍，以及正文里挂十几张 5MB 的图会让公告页打开很慢。
 */
export const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024

/**
 * 上传一张**公开**图片，供富文本正文的 `<img src>` 直接加载。
 *
 * 🔴 和 `useUploadFile` 分成两个函数是刻意的，不是重复代码。
 *
 * `?public=true` 会让文件落进后端那棵被 `/uploads` 无鉴权挂出去的子树 ——
 * 知道 URL 的人不登录也能读。把它做成 `useUploadFile` 的一个可选参数，
 * 就只剩「谁记得别在文件管理页传 true」这一道纪律在守着；拆成两个名字之后，
 * 通用上传路径**在类型上就产生不了公开文件**。
 *
 * 文件管理页那个上传按钮会有身份证扫描件之类的图片，
 * 而后端的闸门只是「公开的必须是图片」，挡不住它。
 */
export async function uploadInlineImage(file: File): Promise<FileItem> {
  return uploadFile<FileItem>('/api/v1/sys/files/upload?public=true', file)
}

export function useDeleteFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (pks: string[]) => api.DELETE('/api/v1/sys/files', { body: { pks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: fileKeys.all }),
  })
}

export function useAttachFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { file_ids: string[]; target_type: string; target_id: string }) =>
      api.POST('/api/v1/sys/files/relations', { body: v }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: fileKeys.target(v.target_type, v.target_id) }),
  })
}

export function useDetachFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { file_ids: string[]; target_type: string; target_id: string }) =>
      api.DELETE('/api/v1/sys/files/relations', { body: v }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: fileKeys.target(v.target_type, v.target_id) }),
  })
}

/**
 * 取字节喂给预览器。
 *
 * 用 `queryOptions` 而不是在组件里裸 fetch，是为了拿到 react-query 的
 * 缓存与去重：同一个文件反复打开预览不该反复下载。
 *
 * ⚠️ `gcTime` 压到 5 分钟：ArrayBuffer 是**真占内存**的，
 * 默认的 5 分钟 gcTime 已经合适，但别把它调大 —— 连开十几个大 PDF
 * 会把几百 MB 摁在缓存里不放。
 */
export const fileBytesQuery = (file: Pick<FileItem, 'id' | 'download_url' | 'size'>) =>
  queryOptions({
    queryKey: [...fileKeys.all, 'bytes', file.id] as const,
    queryFn: () => fetchBytes(file.download_url),
    gcTime: 5 * 60 * 1000,
    staleTime: Infinity,
  })

/**
 * 缩略图的体积上限。超过就只显示类型图标。
 *
 * 后端**没有缩略图列**（ContiNew Admin 有 `thumbnail_name` / `thumbnail_size`），
 * 所以这里是「把原图整个取回来当缩略图」—— 一屏 30 张 5MB 的图就是 150MB。
 * 1MB 的闸门是权衡：常见截图/图标都在这条线以下，能看到真实预览；
 * 大图退回图标，不至于把浏览器压垮。
 *
 * 真正的解法是后端出缩略图（Pillow + 一列 `thumbnail_name`），
 * 那时把这个上限和 `fileThumbQuery` 一起删掉。
 */
const THUMB_MAX_BYTES = 1024 * 1024

export function canThumbnail(file: Pick<FileItem, 'type' | 'size' | 'ext'>): boolean {
  // svg 走 <img> 会把外链/脚本一起解析，当缩略图不值这个风险 —— 退回图标
  return file.type === 'image' && file.ext.toLowerCase() !== 'svg' && file.size <= THUMB_MAX_BYTES
}

/**
 * 缩略图字节。
 *
 * 单独一个 query 而不是复用 `fileBytesQuery`：预览要的是「打开这一个文件」，
 * 缩略图是「一屏几十个」，两者的缓存寿命不该共享 —— 这里 gcTime 短得多，
 * 滚过去的图尽快让 GC 收走。
 */
export const fileThumbQuery = (file: Pick<FileItem, 'id' | 'download_url'>) =>
  queryOptions({
    queryKey: [...fileKeys.all, 'thumb', file.id] as const,
    queryFn: () => fetchBytes(file.download_url),
    gcTime: 60 * 1000,
    staleTime: Infinity,
    retry: false,
  })

/** 宫格 / 列表。默认宫格 —— 文件管理是「看东西」，不是「读表格」 */
export type FileView = 'grid' | 'list'

/** 预览器能渲染的扩展名。装了哪些 renderer 就只支持哪些 —— 见 apps/web/vite.config.ts */
const PREVIEWABLE = new Set([
  // renderer-pdf
  'pdf',
  // renderer-word
  'docx', 'doc', 'rtf', 'odt',
  // renderer-spreadsheet
  'xlsx', 'xls', 'csv',
  // renderer-image
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif',
  // renderer-text
  'txt', 'md', 'json', 'xml', 'log', 'html', 'htm', 'css', 'js', 'ts', 'yaml', 'yml',
  // renderer-archive
  'zip', 'tar', 'gz', '7z',
])

export function isPreviewable(file: Pick<FileItem, 'ext'>): boolean {
  return PREVIEWABLE.has(file.ext.toLowerCase())
}

/**
 * 人类可读的体积。`formatNumber` 管不了单位，这里自己来。
 *
 * 单位**不过 `t()`**：B / KB / MB / GB 中英文写法一样，没有可翻译的内容。
 * 而且 `check.mjs` 只记录**含中文**的 key（第 75 行的 `CN.test`），
 * `t('{{n}} B')` 这种纯 ASCII key 会被 extra-keys 判成孤儿、
 * 被 `i18n:fix` 删掉 —— 然后 key 缺失时 i18next 连插值都不做，
 * 界面上就是字面量 `{{n}} B`（CLAUDE.md 里记过这个失败模式）。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  // 小于 10 给一位小数，大于 10 取整 —— `1.2 MB` 有用，`123.4 MB` 那位小数是噪音
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value))
  return `${shown} ${units[i]}`
}

export const FILE_TYPE_LABEL: Record<FileType, string> = {
  image: '图片',
  document: '文档',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
  other: '其他',
}
