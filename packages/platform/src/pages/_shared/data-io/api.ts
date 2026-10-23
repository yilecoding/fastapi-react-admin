import { queryOptions, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'

import { api, uploadFile, type PageData } from '../../../api-client/client'
import { downloadFile } from '../../../api-client/download'

/*
 * 导入导出的前端那一半（#11 · v0.4）。后端是一个通用框架（`apps/api/backend/common/dataio/`），
 * 每个资源只登记一份定义 —— 所以这里也只有一份：哪一页要导出 / 导入，传它的接口前缀进来。
 */

// ─── 导出 ────────────────────────────────────────────────────────────────────

export type ExportFormat = 'xlsx' | 'csv'

/** 和后端 `ExportJobStatus` 一一对应 */
export const EXPORT_STATUS = { pending: 0, running: 1, succeeded: 2, failed: 3, expired: 4 } as const

export type ExportJob = {
  /** 雪花 ID，一律字符串（硬纪律 6） */
  id: string
  resource: string
  title: string
  format: ExportFormat
  status: number
  /** 发起时按条件数出的行数 */
  total: number
  /** 已写出的行数：生成中是进度，完成后是最终行数 */
  row_count: number | null
  file_name: string
  file_size: number | null
  file_sha256: string | null
  error: string | null
  download_count: number
  created_time: string
  started_time: string | null
  finished_time: string | null
  expire_time: string | null
}

export type StartExportBody = {
  format: ExportFormat
  /** 只导这些列（后端的列 key，按这个顺序）；不给 = 全部列 */
  columns?: string[]
  /** 只导选中的行；不给 = 按筛选条件导 */
  ids?: string[]
  /** 和列表接口的查询参数同名。**拼错一个后端会拒绝**（不是忽略）—— 忽略的话导出的是全表 */
  filters?: Record<string, unknown>
}

export const exportKeys = {
  all: ['exports'] as const,
  list: (p: { page: number; size: number; status?: number }) => [...exportKeys.all, 'list', p] as const,
}

/**
 * 发起一次导出。小批量后端当场生成完（`status = 2`，直接下载）；大批量返回排队中（`status = 0`），
 * 生成完发站内消息。两种都是 200 —— 调用方按 `status` 分支，不要按「请求有没有成功」
 */
export function useStartExport(path: string) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (body: StartExportBody) => api.POST<ExportJob>(path, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: exportKeys.all }),
  })
}

export const myExportsQuery = (p: { page: number; size: number; status?: number }) =>
  queryOptions({
    queryKey: exportKeys.list(p),
    queryFn: () => {
      const q = new URLSearchParams({ page: String(p.page), size: String(p.size) })
      if (p.status !== undefined) q.set('status', String(p.status))
      return api.GET<PageData<ExportJob>>(`/api/v1/sys/exports?${q}`)
    },
    // 有在排队 / 生成中的就隔几秒再取一次（进度条在动）；全都结束了就不再轮询
    refetchInterval: (query) =>
      query.state.data?.items.some((j) => j.status === EXPORT_STATUS.pending || j.status === EXPORT_STATUS.running)
        ? 3000
        : false,
  })

export function downloadExport(job: ExportJob): Promise<void> {
  return downloadFile(`/api/v1/sys/exports/${job.id}/download`, job.file_name)
}

export function useDeleteExport() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (id: string) => api.DELETE(`/api/v1/sys/exports/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: exportKeys.all }),
  })
}

// ─── 导入 ────────────────────────────────────────────────────────────────────

/**
 * 三种模式（和后端 `ImportMode` 同名）：
 * `create` 只新增（已存在算错）· `upsert` 新增并更新 · `update` 只更新（不存在算错）
 */
export type ImportMode = 'create' | 'upsert' | 'update'

export type ImportColumn = { key: string; label: string; required: boolean }

/** 预览里的一行。`row_no` 是 **Excel 里的真实行号**（表头是 1），不是「第几条」 */
export type ImportPreviewRow = {
  row_no: number
  /** 原样的单元格文本，按列 key 取 */
  values: Record<string, string | null>
  ok: boolean
  /** 会做什么：`create` / `update`；有问题的行为空 */
  action: 'create' | 'update' | null
  errors: string[]
}

export type ImportPreview = {
  import_token: string
  expire_seconds: number
  mode: ImportMode
  columns: ImportColumn[]
  total: number
  valid: number
  to_create: number
  to_update: number
  rows: ImportPreviewRow[]
  /**
   * 表头里没被认领的列。**必须显示出来** —— 列名拼错时整份文件照样解析成功，
   * 只是那一列的数据全丢了，纯静默
   */
  ignored_headers: string[]
  empty_rows: number
  has_report: boolean
}

export type ImportCommitResult = {
  /** false 只在「全部成功才导入」且有行失败时出现：这时**一行都没写** */
  committed: boolean
  created: string[]
  updated: string[]
  failed: Array<{ row_no: number; msg: string }>
  notes: string[]
  has_report: boolean
}

/**
 * 上传 xlsx 做预览。**只校验不落库**。
 *
 * ⚠️ 走 `uploadFile` 而不是 `api.POST` —— 它是 multipart，而且成败判定过
 * `resolveEnvelope`（FBA 的 `fail()` 是 HTTP 200 + `code: 400`，只看 `res.ok` 会把被拒的上传当成功）
 */
export function useImportPreview(base: string) {
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ file, mode }: { file: File; mode: ImportMode }) =>
      uploadFile<ImportPreview>(`${base}/preview?mode=${mode}`, file),
  })
}

/**
 * 凭预览的令牌落库。
 *
 * ⚠️ **令牌是一次性的**：服务端在写库之前就把它删了（不删的话双击 / 重试会写两遍）。
 * 所以提交失败之后不能拿同一个令牌重试 —— 要让用户重新上传
 */
export function useImportCommit(base: string, invalidate: QueryKey) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (body: { import_token: string; exclude_rows: number[]; atomic: boolean }) =>
      api.POST<ImportCommitResult>(`${base}/commit`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidate }),
  })
}

export function downloadImportTemplate(base: string, fallback: string): Promise<void> {
  return downloadFile(`${base}/template`, fallback)
}

/** 错误报告：有问题的行原样 + 原因，改完能直接再导。和令牌同寿命，只给发起人 */
export function downloadImportReport(token: string, fallback: string): Promise<void> {
  return downloadFile(`/api/v1/sys/imports/${token}/report`, fallback)
}
