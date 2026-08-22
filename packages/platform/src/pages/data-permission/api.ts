import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * 数据权限的数据层 —— 原先拆在 `data-scope/` 和 `data-rule/` 两个页面里，合并到这里。
 *
 * 三层关系：
 * ```
 * 角色 ──m2m──> 数据范围 ──m2m──> 数据规则 ──> SQL WHERE 条件
 * ```
 * ⚠️ 但**数据范围在运行时是不存在的**：`common/security/permission.py: filter_data_permission`
 * 把所有角色、所有范围里的规则倒进同一个 set，再按每条规则自己的 AND/OR 重新分组，
 * 拼成 `or_( and_(全部 AND 规则), or_(全部 OR 规则) )`。范围只是给一捆规则起个名字，
 * 好让角色有东西可绑 —— 它不构成任何查询边界。
 *
 * 由此推出两个界面上的必需品：
 * - 一条 OR 规则会**绕过**全局所有 AND 规则，所以范围内混用 AND/OR 必须报警
 * - 规则表是 m2m 但实测零复用，所以主操作是「新建规则并挂上」，不是「从规则池里挑」
 */

// ─── 数据范围 ─────────────────────────────────────────────────────────────────

export type DataScope = {
  id: string
  name: string
  status: number
  created_time: string
  updated_time: string | null
}

export type ScopeListParams = { page: number; size: number; name?: string; status?: number }

export const scopeKeys = {
  all: ['sys', 'data-scope'] as const,
  list: (p: ScopeListParams) => [...scopeKeys.all, 'list', p] as const,
  detail: (id: string) => [...scopeKeys.all, id, 'detail'] as const,
  rules: (id: string) => [...scopeKeys.all, id, 'rules'] as const,
}

export const dataScopesQuery = (p: ScopeListParams) =>
  queryOptions({
    queryKey: scopeKeys.list(p),
    queryFn: () => {
      const s = new URLSearchParams({ page: String(p.page), size: String(p.size) })
      if (p.name) s.set('name', p.name)
      if (p.status !== undefined) s.set('status', String(p.status))
      return api.GET<PageData<DataScope>>(`/api/v1/sys/data-scopes?${s}`)
    },
    placeholderData: (prev) => prev,
  })

/**
 * 按 id 取单个数据范围。
 *
 * 存在的理由和 `role/api.ts` 的 `roleDetailQuery` 一样：范围列表是**分页**的，
 * `?scope=<id>` 深链指向的范围可能不在当前页。只在当前页里 find 会静默落回第一条 ——
 * 那意味着「你以为在给范围 X 配规则，实际改的是列表第一条」。
 */
export const scopeDetailQuery = (id: string) =>
  queryOptions({
    queryKey: scopeKeys.detail(id),
    queryFn: () => api.GET<DataScope>(`/api/v1/sys/data-scopes/${id}`),
    enabled: Boolean(id),
    retry: false,
  })

/**
 * 该范围下已挂的规则。
 *
 * ⚠️ 这个接口返回的是**范围对象本身 + 嵌套的 rules 数组**，不是裸数组
 * （和 `roles/{id}/menus` 直接返回数组的形状不一致，实测确认）。
 * 这里统一拆成数组，调用方不用关心。
 */
type ScopeWithRules = DataScope & { rules: DataRule[] }

export const scopeRulesQuery = (id: string) =>
  queryOptions({
    queryKey: scopeKeys.rules(id),
    queryFn: async () => {
      const res = await api.GET<ScopeWithRules | DataRule[]>(`/api/v1/sys/data-scopes/${id}/rules`)
      return Array.isArray(res) ? res : (res?.rules ?? [])
    },
    enabled: Boolean(id),
  })

export type DataScopeBody = { name: string; status: number }

const invScopes = (qc: ReturnType<typeof useQueryClient>) => () =>
  qc.invalidateQueries({ queryKey: scopeKeys.all })

export function useCreateDataScope() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: DataScopeBody) => api.POST('/api/v1/sys/data-scopes', { body: b }),
    onSuccess: invScopes(qc),
  })
}

export function useUpdateDataScope() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DataScopeBody }) =>
      api.PUT(`/api/v1/sys/data-scopes/${id}`, { body }),
    onSuccess: invScopes(qc),
  })
}

export function useDeleteDataScopes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.DELETE('/api/v1/sys/data-scopes', { body: { pks: ids } }),
    onSuccess: invScopes(qc),
  })
}

/** 覆盖式更新：传什么就是什么，传空数组即解除全部绑定 */
export function useUpdateScopeRules() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, rules }: { id: string; rules: string[] }) =>
      api.PUT(`/api/v1/sys/data-scopes/${id}/rules`, { body: { rules } }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: scopeKeys.rules(v.id) })
      qc.invalidateQueries({ queryKey: scopeKeys.all })
      // 规则变了，用户能看到的数据跟着变
      qc.invalidateQueries({ queryKey: ['auth'] })
    },
  })
}

// ─── 数据规则 ─────────────────────────────────────────────────────────────────

export type DataRule = {
  id: string
  name: string
  /** 作用的模型名，`__ALL__` 表示全部 */
  model: string
  /** 模型字段；模板字段形如 `__dept_id__` */
  column: string
  /** 0: and, 1: or */
  operator: number
  /** 0:== 1:!= 2:> 3:>= 4:< 5:<= 6:in 7:not_in */
  expression: number
  value: string
  created_time: string
}

export type ModelColumn = { key: string; comment: string | null }
export type TemplateVar = { key: string; comment: string }

export const ruleKeys = {
  all: ['sys', 'data-rule'] as const,
  models: () => [...ruleKeys.all, 'models'] as const,
  columns: (m: string) => [...ruleKeys.all, 'columns', m] as const,
  vars: () => [...ruleKeys.all, 'vars'] as const,
}

export const allRulesQuery = queryOptions({
  queryKey: [...ruleKeys.all, 'all'] as const,
  queryFn: () => api.GET<DataRule[]>('/api/v1/sys/data-rules/all'),
  staleTime: 60_000,
})

export const rlModelsQuery = queryOptions({
  queryKey: ruleKeys.models(),
  queryFn: () => api.GET<string[]>('/api/v1/sys/data-rules/models'),
  staleTime: 10 * 60_000,
})

export const rlColumnsQuery = (model: string) =>
  queryOptions({
    queryKey: ruleKeys.columns(model),
    queryFn: () => api.GET<ModelColumn[]>(`/api/v1/sys/data-rules/models/${model}/columns`),
    enabled: Boolean(model) && model !== '__ALL__',
    staleTime: 10 * 60_000,
  })

export const templateVarsQuery = queryOptions({
  queryKey: ruleKeys.vars(),
  queryFn: () => api.GET<TemplateVar[]>('/api/v1/sys/data-rules/value-template-variables'),
  staleTime: 10 * 60_000,
})

export type DataRuleBody = {
  name: string
  model: string
  column: string
  operator: number
  expression: number
  value: string
}

const invRules = (qc: ReturnType<typeof useQueryClient>) => () => {
  qc.invalidateQueries({ queryKey: ruleKeys.all })
  // 规则内容变了，各范围下挂的那份也要重取
  qc.invalidateQueries({ queryKey: scopeKeys.all })
}

/** 后端返回新建的规则本体（本仓库改的），调用方拿 id 直接挂到当前范围上 */
export function useCreateDataRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: DataRuleBody) => api.POST<DataRule>('/api/v1/sys/data-rules', { body: b }),
    onSuccess: invRules(qc),
  })
}

export function useUpdateDataRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DataRuleBody }) =>
      api.PUT(`/api/v1/sys/data-rules/${id}`, { body }),
    onSuccess: invRules(qc),
  })
}

export function useDeleteDataRules() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.DELETE('/api/v1/sys/data-rules', { body: { pks: ids } }),
    onSuccess: invRules(qc),
  })
}

// ─── 枚举（与后端 `common/security/permission.py` 的匹配分支一一对应） ──────────

export const OPERATOR_ITEMS: Record<string, string> = { '0': 'AND（且）', '1': 'OR（或）' }

export const EXPRESSION_ITEMS: Record<string, string> = {
  '0': '等于 ==', '1': '不等于 !=', '2': '大于 >', '3': '大于等于 >=',
  '4': '小于 <', '5': '小于等于 <=', '6': '包含 in', '7': '不包含 not in',
}

/** 表格里只想要符号那一半 */
export function expressionSymbol(expression: number): string {
  return (EXPRESSION_ITEMS[String(expression)] ?? String(expression)).split(' ')[1] ?? ''
}
