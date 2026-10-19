import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * AI 模型供应商（「模型密钥管理」）。
 *
 * 🔴 **接口永远不下发 api_key，连密文都不下发** —— 只有 `api_key_mask`。
 * 所以编辑时密钥框是空的，留空表示不修改。想改就重新填一次，没有回显（同密码）。
 */
export type AiProvider = {
  id: string
  name: string
  provider_type: 'openai' | 'deepseek' | 'qwen' | 'glm' | 'custom'
  base_url: string
  model: string
  api_key_mask: string
  timeout: number
  verify_ssl: boolean
  /** 内网网关按实际可达路径选；配错表现为纯超时 */
  use_proxy: boolean
  max_retries: number
  is_default: boolean
  status: number
  remark: string | null
  created_time: string
}

export type AiProviderBody = {
  name: string
  provider_type: AiProvider['provider_type']
  base_url: string
  model: string
  /** 新建必填；编辑时留空 = 不改 */
  api_key?: string
  timeout: number
  verify_ssl: boolean
  use_proxy: boolean
  max_retries: number
  is_default: boolean
  status: number
  remark?: string | null
}

export type TestResult = { ok: boolean; message: string; latency_ms: number | null }

/** 各家的默认地址与模型。选了类型就把这两个框填上，省得人去翻文档。 */
export const PROVIDER_PRESETS: Record<AiProvider['provider_type'], { base_url: string; model: string }> = {
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  // 内网自建网关走这一档：地址形如 https://openapi.example.com:8086/LLM_api/v1
  custom: { base_url: '', model: '' },
}

export const PROVIDER_TYPE_LABELS: Record<AiProvider['provider_type'], string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  glm: '智谱 GLM',
  custom: '自定义 / 内网网关',
}

export const providerKeys = {
  all: ['ai-provider'] as const,
  list: () => [...providerKeys.all, 'list'] as const,
}

export function providersQuery() {
  return queryOptions({
    queryKey: providerKeys.list(),
    queryFn: () => api.GET<PageData<AiProvider>>('/api/v1/ai/providers?page=1&size=50'),
  })
}

export function useCreateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AiProviderBody) => api.POST('/api/v1/ai/providers', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.all }),
  })
}

export function useUpdateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AiProviderBody }) =>
      api.PUT(`/api/v1/ai/providers/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.all }),
  })
}

export function useDeleteProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/ai/providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.all }),
  })
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) => api.POST<TestResult>(`/api/v1/ai/providers/${id}/test`),
  })
}
