import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'

/**
 * 存储管理（`sys_storage`，#122）。
 *
 * - 列表第一行永远是**内置本地存储**（`id === 'builtin'`）：它不是表里的一行，不能改、不能删，
 *   只能被设为默认。表里没有任何一行是默认时，它就是默认
 * - 🔴 **接口永远不下发 SecretKey，连密文都不下发** —— 只有 `secret_hint`。编辑时密钥框是空的，
 *   留空表示不修改（同 AI 供应商）
 * - 切默认存储**只影响新上传**，老文件仍从它自己的存储读
 */
export type StorageType = 'local' | 's3'
export type StorageAddressing = 'auto' | 'virtual' | 'path'

export const BUILTIN_STORAGE_ID = 'builtin'

export type Storage = {
  id: string
  name: string
  code: string
  type: StorageType
  root: string
  endpoint: string | null
  bucket: string | null
  region: string | null
  addressing: StorageAddressing
  access_key: string | null
  secret_hint: string | null
  public_base_url: string | null
  is_default: boolean
  status: number
  remark: string | null
  builtin: boolean
  file_count: number
  created_time: string | null
  updated_time: string | null
}

export type StorageBody = {
  name: string
  root: string
  endpoint?: string | null
  bucket?: string | null
  region?: string | null
  addressing: StorageAddressing
  access_key?: string | null
  /** 新建 S3 必填；编辑时留空 = 不改 */
  secret_key?: string
  public_base_url?: string | null
  remark?: string | null
}

export type CreateStorageBody = StorageBody & { code: string; type: StorageType }

export type TestResult = { ok: boolean; message: string }

export const STORAGE_TYPE_LABELS: Record<StorageType, string> = {
  local: '本地磁盘',
  s3: '对象存储（S3 兼容）',
}

export const ADDRESSING_LABELS: Record<StorageAddressing, string> = {
  auto: '自动（按端点判断）',
  virtual: '虚拟主机风格（bucket.endpoint）',
  path: '路径风格（endpoint/bucket）',
}

export const storageKeys = {
  all: ['storage'] as const,
  list: () => [...storageKeys.all, 'list'] as const,
}

export function storagesQuery() {
  return queryOptions({
    queryKey: storageKeys.list(),
    queryFn: () => api.GET<Storage[]>('/api/v1/sys/storages'),
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: storageKeys.all })
}

export function useCreateStorage() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: CreateStorageBody) => api.POST('/api/v1/sys/storages', { body }),
    onSuccess: invalidate,
    // 表单里已经内联显示了后端的报错，全局 toast 再弹一遍只是噪音（app.tsx 的 MutationCache）
    meta: { suppressErrorToast: true },
  })
}

export function useUpdateStorage() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: StorageBody }) => api.PUT(`/api/v1/sys/storages/${id}`, { body }),
    onSuccess: invalidate,
    meta: { suppressErrorToast: true },
  })
}

export function useDeleteStorage() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/sys/storages/${id}`),
    onSuccess: invalidate,
  })
}

/** 设默认。内置存储传 `null`（它在接口上的 id 是 `builtin`，不是雪花 ID） */
export function useSetDefaultStorage() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) =>
      api.PUT('/api/v1/sys/storages/default', {
        body: { storage_id: id === BUILTIN_STORAGE_ID ? null : id },
      }),
    onSuccess: invalidate,
  })
}

export function useSetStorageStatus() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: number }) =>
      api.PUT(`/api/v1/sys/storages/${id}/status`, { body: { status } }),
    onSuccess: invalidate,
  })
}

export function useTestStorage() {
  return useMutation({
    mutationFn: (id: string) => api.POST<TestResult>(`/api/v1/sys/storages/${id}/test`),
  })
}
