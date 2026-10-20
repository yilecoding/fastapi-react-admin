import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, fetchBytes, uploadFile, type PageData } from '../../api-client/client'

/**
 * 审批流的接口与类型（issue #107）。
 *
 * ⚠️ 前缀是 **`/api/v1/sys/workflow`** —— 插件 `extend = "admin"`，路由被挂在 admin 的 sys 下
 * （同消息中心那条）。
 *
 * ⚠️ 所有 ID 都是雪花**字符串**，不要 `Number()`（硬纪律 6）。表单里人员 / 部门字段的值
 * 也是字符串，后端拿到数字会直接拒绝。
 */
const BASE = '/api/v1/sys/workflow'

// ── 表单 schema ──────────────────────────────────────────────────────────────

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'amount'
  | 'date'
  | 'daterange'
  | 'select'
  | 'multiselect'
  | 'user'
  | 'dept'
  | 'attachment'
  | 'description'
  | 'table'

export type FieldOption = { label: string; value: string }

export type FormField = {
  /** 生成的稳定 ID —— 条件和历史数据都按它引用，改标签不影响 */
  id: string
  type: FieldType
  label: string
  required?: boolean
  placeholder?: string | null
  options?: FieldOption[] | null
  precision?: number | null
  multiple?: boolean
  content?: string | null
  columns?: FormField[] | null
  /** 显示条件：只能引用排在前面的字段。不成立时不显示、不校验、不保存 */
  visibleWhen?: Cond | null
  /** 自动计算（number / amount）：服务端算，填了也不收 */
  calc?: Calc | null
}

export type Calc = { kind: 'days'; field: string } | { kind: 'sum'; field: string; column: string }

export type FormSchema = { schemaVersion: 1; fields: FormField[] }

export type FormData = Record<string, unknown>

// ── 流程模型（树）────────────────────────────────────────────────────────────

export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { var: string; op: CondOp; value?: unknown }

export type CondOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'empty' | 'not_empty'

export type AssigneeKind = 'user' | 'role' | 'dept_leader' | 'initiator' | 'var_user' | 'select_on_start'

export type AssigneeRule = {
  kind: AssigneeKind
  user_ids?: string[]
  role_ids?: string[]
  level?: number
  field?: string
  scope?: 'none' | 'initiator_dept' | 'initiator_dept_tree'
}

export type FieldPerm = 'hidden' | 'readonly' | 'editable'

export type ApprovalMode = 'any' | 'all' | 'seq'

export type OptionalAction = 'transfer' | 'cc' | 'send_back' | 'add_sign'

export type ApprovalNode = {
  type: 'approval'
  id: string
  name: string
  mode: ApprovalMode
  assignee?: AssigneeRule | null
  onEmpty: 'reject' | 'skip' | 'admin'
  /** null = 默认全开；[] = 只有同意 / 驳回 */
  actions?: OptionalAction[] | null
  /** 待办到手上 `hours` 小时没办：提醒（每隔这么久一次，最多 3 次）/ 自动同意 / 自动驳回 */
  timeout?: { hours: number; action: 'remind' | 'approve' | 'reject' } | null
  fieldPerms?: Record<string, FieldPerm>
  next: FlowNode | null
}

export type CcNode = { type: 'cc'; id: string; name: string; targets: AssigneeRule[]; next: FlowNode | null }

export type Branch = { id: string; name: string; default?: boolean; when?: Cond | null; child: FlowNode | null }

export type ConditionNode = { type: 'condition'; id: string; name: string; branches: Branch[]; next: FlowNode | null }

export type FlowNode = ApprovalNode | CcNode | ConditionNode

/** 开始节点。`fieldPerms` 是**发起人**的字段权限，没配 = 可填（审批节点没配 = 只读） */
export type StartNode = { type: 'start'; id: string; fieldPerms?: Record<string, FieldPerm>; next: FlowNode | null }

/** AI 预审（#111）：跟着流程模型一起发布，在途的单按发起时的要点审 */
export type AiReviewConfig = { enabled: boolean; points: string }

export type FlowModel = { schemaVersion: 1; root: StartNode; aiReview?: AiReviewConfig | null }

export type AiVerdict = 'pass' | 'attention' | 'reject'

/**
 * `GET /instances/{pk}/ai-review`。理由已经按查看人裁过（服务端），前端照着显示。
 * `visible: false` = 这个人不该看（发起人）—— 那是服务端明确的「不给」，不是失败。
 */
export type AiReview =
  | { visible: false; enabled: false }
  | {
      visible: true
      enabled: boolean
      /** null = 这张单没有预审过（定义没开，或者开之前发起的） */
      status: 'pending' | 'done' | 'failed' | 'timeout' | null
      verdict?: AiVerdict | null
      reasons?: { field_id: string | null; text: string }[]
      error?: string | null
      model?: string | null
      created_time?: string
      finished_time?: string | null
      /** 被退回重新提交过几次：之前的预审结论都作废了 */
      superseded?: number
    }

// ── 实例 ─────────────────────────────────────────────────────────────────────

export type InstanceStatus = 'running' | 'approved' | 'rejected' | 'withdrawn' | 'terminated'

export type Action =
  | 'approve' | 'reject' | 'withdraw' | 'transfer' | 'cc' | 'remind' | 'terminate' | 'send_back' | 'reassign'
  | 'take_back' | 'add_sign'

export type InstanceRow = {
  id: string
  title: string
  summary: string | null
  definition_id: string
  definition_name: string | null
  status: InstanceStatus
  initiator_id: string
  initiator_name: string | null
  current_node_id: string | null
  created_time: string
  finished_time: string | null
  // 各列表各自补的字段
  task_id?: string
  node_name?: string
  arrived_time?: string
  decision?: string
  handled_time?: string | null
  cc_id?: string
  read_time?: string | null
  cc_time?: string
  /** 发起人标了加急：待办列表排前面 */
  urgent?: boolean
  /** 实例监控：在办的单子当前在哪一步、谁手上 */
  current_node_name?: string | null
  handlers?: string[]
}

export type TaskRow = {
  id: string
  node_id: string
  node_name: string
  assignee_id: string
  assignee_name: string
  origin_assignee_id: string | null
  /** 第几轮进入这个节点：退回之后重走同一个节点时不同，进度按「节点 + 轮次」分组 */
  batch: number
  /** 节点配了超时、待办还在办：什么时候会被提醒 / 自动处理 */
  due_time?: string | null
  /** 办理人第一次打开这张单的时间（「已读」） */
  read_time?: string | null
  status: 'pending' | 'done' | 'canceled' | 'transferred'
  /** resubmit = 被退回后发起人重新提交 */
  decision: 'approve' | 'reject' | 'send_back' | 'resubmit' | 'add_sign' | 'take_back' | null
  opinion: string | null
  created_time: string
  finished_time: string | null
}

export type RecordRow = {
  id: string
  task_id: string | null
  action: string
  actor_type: 'user' | 'system'
  actor_id: string | null
  actor_name: string | null
  node_id: string | null
  node_name: string | null
  target_user_name: string | null
  opinion: string | null
  detail: {
    branch?: string
    name?: string
    form_changes?: Record<string, { from: unknown; to: unknown }>
    /** 退回到哪 */
    to?: string
    to_name?: string
    /** 改办理人：原来是谁 */
    from?: string
    /** 退回时选了「直接回到我这一步」 */
    resume?: boolean
    /** 加签：在我之前 / 之后 */
    mode?: 'before' | 'after'
  } | null
  created_time: string
}

export type Capability = { action: Action; enabled: boolean; reason: string | null }

export type InstanceDetail = {
  instance: InstanceRow & { seq: number; biz_id: string | null; definition_code: string }
  /** 已经按当前查看人裁掉了隐藏字段（服务端做的） */
  form_schema: FormSchema
  form_data: FormData
  /** 当前查看人若有待办：字段 ID → 权限；没有待办时为空 */
  field_perms: Record<string, FieldPerm>
  model: FlowModel
  /** 节点 ID → done / current / rejected；`branch:<分支 ID>` → taken */
  node_state: Record<string, string>
  tasks: TaskRow[]
  records: RecordRow[]
  ccs: { user_id: string; user_name: string | null; read_time: string | null }[]
  capabilities: Capability[]
  my_task_id: string | null
  /** 表单里看得见的附件 → 文件名 / 大小（隐藏字段里的不下发） */
  files: Record<string, FileMeta>
  /** 流程图里出现的用户 / 角色 ID → 名字（看图的人不一定有权限查角色 / 用户接口） */
  names: ModelNames
  /** 还没走到的步骤（服务端试算，和真实推进同一套规则） */
  forecast: ForecastStep[]
  /** 能退回到哪（只有当前能「退回」的人有）：第一个是发起人 */
  send_back_targets: { node_id: string; name: string }[]
  /** 依次审批的当前节点上，排在后面还没轮到的人。`masked` = 来自看不到的人员字段 */
  waiting: { id: string | null; name: string | null; masked?: boolean }[]
  /** 被退回到发起人时：「发起人自选」节点和之前选的人。改了表单后新路上的这类节点必须选（服务端判） */
  select_nodes: { id: string; name: string; selected: string[] }[]
}

export type ForecastStep = {
  node_id: string
  name: string
  type: 'approval' | 'cc'
  mode: ApprovalMode
  users: { id: string; name: string }[]
  /** ok 有人办 · pick 发起人自选还没选 · skip 跳过 · admin 转给管理员 · reject 将被自动驳回 */
  outcome: 'ok' | 'pick' | 'skip' | 'admin' | 'reject'
  /** 办理人来自查看人看不到的人员字段：服务端不给名字 */
  masked?: boolean
}

export type FileMeta = { id?: string; name: string; size: number; ext: string; content_type: string | null }

export type ModelNames = { users: Record<string, string>; roles: Record<string, string> }

export type Definition = {
  id: string
  code: string
  name: string
  biz_type: string
  category: string | null
  icon: string | null
  description: string | null
  status: 'draft' | 'published' | 'disabled'
  current_version_id: string | null
  /** 当前发布版本的版本号（只有列表接口带） */
  version_no?: number | null
  sort: number
  created_time: string
  updated_time: string | null
  form?: FormSchema
  model?: FlowModel
}

export type Issue = { level: 'ERROR' | 'WARN'; code: string; message: string; nodeId?: string; fieldId?: string }

export type DirectoryUser = { id: string; nickname: string; username: string; dept_name: string | null }
export type DirectoryDept = { id: string; name: string; parent_id: string | null }

// ── query keys ───────────────────────────────────────────────────────────────

export type InboxTab = 'todo' | 'done' | 'initiated' | 'cc'

export type InboxParams = { tab: InboxTab; page: number; size: number; keyword?: string; status?: string }

export const workflowKeys = {
  all: ['sys', 'workflow'] as const,
  inbox: () => [...workflowKeys.all, 'inbox'] as const,
  list: (p: InboxParams) => [...workflowKeys.inbox(), p] as const,
  counts: () => [...workflowKeys.all, 'counts'] as const,
  detail: (id: string) => [...workflowKeys.all, 'detail', id] as const,
  aiReview: (id: string) => [...workflowKeys.all, 'detail', id, 'ai-review'] as const,
  startable: () => [...workflowKeys.all, 'startable'] as const,
  startForm: (code: string) => [...workflowKeys.all, 'start-form', code] as const,
  monitor: (p: object) => [...workflowKeys.all, 'monitor', p] as const,
  definitions: () => [...workflowKeys.all, 'definitions'] as const,
  definition: (id: string) => [...workflowKeys.all, 'definition', id] as const,
  versions: (id: string) => [...workflowKeys.all, 'versions', id] as const,
  users: (q: object) => [...workflowKeys.all, 'directory', 'users', q] as const,
  depts: () => [...workflowKeys.all, 'directory', 'depts'] as const,
}

function qs(p: Record<string, string | number | boolean | undefined | null>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  return s.toString()
}

export const inboxQuery = (p: InboxParams) =>
  queryOptions({
    queryKey: workflowKeys.list(p),
    queryFn: () =>
      api.GET<PageData<InstanceRow>>(
        `${BASE}/inbox/${p.tab}?${qs({ page: p.page, size: p.size, keyword: p.keyword, status: p.status })}`
      ),
    placeholderData: (prev) => prev,
  })

/**
 * 待办数。🔴 和铃铛未读数同一个口径：它必须能靠这条 REST 调用拿到正确值，
 * socket 的 `workflow:todo` 只是让它早点重取，不是送达保证。
 */
export const countsQuery = () =>
  queryOptions({
    queryKey: workflowKeys.counts(),
    queryFn: () => api.GET<{ todo: number; cc_unread: number }>(`${BASE}/inbox/counts`),
  })

export const detailQuery = (id: string) =>
  queryOptions({
    queryKey: workflowKeys.detail(id),
    queryFn: () => api.GET<InstanceDetail>(`${BASE}/instances/${id}`),
  })

/** 预审中每 3 秒问一次；出结果 / 失败就停。单开接口就是为了这个 —— 不该每 3 秒重取整张单 */
export const aiReviewQuery = (id: string) =>
  queryOptions({
    queryKey: workflowKeys.aiReview(id),
    queryFn: () => api.GET<AiReview>(`${BASE}/instances/${id}/ai-review`),
    refetchInterval: (q) => (q.state.data && 'status' in q.state.data && q.state.data.status === 'pending' ? 3000 : false),
  })

export const startableQuery = () =>
  queryOptions({ queryKey: workflowKeys.startable(), queryFn: () => api.GET<Definition[]>(`${BASE}/startable`) })

export type StartForm = {
  definition: Definition
  version_id: string
  form: FormSchema
  model: FlowModel
  select_nodes: { id: string; name: string; mode: string }[]
  names: ModelNames
}

export const startFormQuery = (code: string) =>
  queryOptions({
    queryKey: workflowKeys.startForm(code),
    queryFn: () => api.GET<StartForm>(`${BASE}/startable/${encodeURIComponent(code)}`),
  })

/** 实例监控。入参由查询区出（keyword / status / definition_id / initiator / start_time / end_time）+ 分页 */
export const monitorQuery = (p: { page: number; size: number } & Record<string, string | number | undefined>) =>
  queryOptions({
    queryKey: workflowKeys.monitor(p),
    queryFn: () => api.GET<PageData<InstanceRow>>(`${BASE}/monitor?${qs(p)}`),
    placeholderData: (prev) => prev,
  })

export const definitionsQuery = () =>
  queryOptions({ queryKey: workflowKeys.definitions(), queryFn: () => api.GET<Definition[]>(`${BASE}/definitions`) })

export const definitionQuery = (id: string) =>
  queryOptions({
    queryKey: workflowKeys.definition(id),
    queryFn: () => api.GET<Definition>(`${BASE}/definitions/${id}`),
  })

export const versionsQuery = (id: string) =>
  queryOptions({
    queryKey: workflowKeys.versions(id),
    queryFn: () =>
      api.GET<{ id: string; version_no: number; published_by: string; created_time: string }[]>(
        `${BASE}/definitions/${id}/versions`
      ),
  })

export const directoryUsersQuery = (q: { keyword?: string; ids?: string[] }) =>
  queryOptions({
    queryKey: workflowKeys.users(q),
    queryFn: () =>
      api.GET<DirectoryUser[]>(`${BASE}/directory/users?${qs({ keyword: q.keyword, ids: q.ids?.join(',') })}`),
    staleTime: 60_000,
  })

export const directoryDeptsQuery = () =>
  queryOptions({
    queryKey: workflowKeys.depts(),
    queryFn: () => api.GET<DirectoryDept[]>(`${BASE}/directory/depts`),
    staleTime: 60_000,
  })

// ── mutations ────────────────────────────────────────────────────────────────

/**
 * 幂等键。🔴 用 http 访问内网时（非安全上下文）**没有 `crypto.randomUUID`**
 * （avc-bp `d694615c` 踩过），所以要有 fallback；后端只要求 8–64 位。
 */
export function idempotencyKey(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
}

export function useStartInstance() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: (body: {
      code: string
      form: FormData
      selected: Record<string, string[]>
      key: string
      urgent?: boolean
      /** 重新发起（内容来自旧单）：提交后别删这个流程的草稿 */
      keep_draft?: boolean
    }) => api.POST<{ instance_id: string; replayed: boolean }>(`${BASE}/instances`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

export function useAct(instanceId: string) {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: (body: {
      action: Action
      key: string
      opinion?: string
      target_user_ids?: string[]
      form?: FormData
      /** 退回到哪个节点 */
      target_node_id?: string
      /** 改办理人：改哪一条待办 */
      task_id?: string
      /** 退回：重新提交后直接回到我这一步 */
      resume?: boolean
      /** 加签：在我之前 / 之后 */
      sign_mode?: 'before' | 'after'
      /** 被退回后重新提交：发起人自选的审批人 */
      selected?: Record<string, string[]>
    }) => api.POST<{ instance_id: string; replayed: boolean }>(`${BASE}/instances/${instanceId}/actions`, { body }),
    // 成功和失败都要重取：失败多半是「已被他人处理」，界面要跟上真实状态
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

/** 预审失败 / 超时之后重跑（成功的服务端不让重跑） */
export function useRetryAiReview(instanceId: string) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: () => api.POST(`${BASE}/instances/${instanceId}/ai-review/retry`),
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.aiReview(instanceId) }),
  })
}

/** 办理人打开了详情：记「已读」（接口只记第一次，重复调无害） */
export function useMarkTaskRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.PUT(`${BASE}/instances/${id}/read`),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: workflowKeys.detail(id) }),
  })
}

// ── 发起草稿（服务端存：换台电脑 / 清了缓存还在）────────────────────────────

export const draftsQuery = () =>
  queryOptions({
    queryKey: [...workflowKeys.all, 'drafts'] as const,
    queryFn: () => api.GET<{ code: string; updated_time: string }[]>(`${BASE}/drafts`),
  })

export const draftQuery = (code: string) =>
  queryOptions({
    queryKey: [...workflowKeys.all, 'drafts', code] as const,
    queryFn: () =>
      api.GET<{ form: FormData; updated_time: string } | null>(`${BASE}/drafts/${encodeURIComponent(code)}`),
    // 草稿只在打开抽屉时读一次：之后以手上正在填的为准，别让后台重取把它盖回去
    staleTime: Infinity,
  })

export function saveDraft(code: string, form: FormData): Promise<unknown> {
  return api.PUT(`${BASE}/drafts/${encodeURIComponent(code)}`, { body: { form } })
}

export function removeDraft(code: string): Promise<unknown> {
  return api.DELETE(`${BASE}/drafts/${encodeURIComponent(code)}`)
}

export function useDeleteDraft() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => api.DELETE(`${BASE}/drafts/${encodeURIComponent(code)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...workflowKeys.all, 'drafts'] }),
  })
}

export function useMarkCcRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.PUT(`${BASE}/instances/${id}/cc-read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workflowKeys.counts() })
      qc.invalidateQueries({ queryKey: workflowKeys.inbox() })
    },
  })
}

export function useCreateDefinition() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: (body: Partial<Definition> & { code: string; name: string; form?: FormSchema; model?: FlowModel }) =>
      api.POST<{ id: string }>(`${BASE}/definitions`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.definitions() }),
  })
}

export function useSaveDefinition() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<Definition, 'name' | 'category' | 'icon' | 'description' | 'sort'>> & { form?: FormSchema; model?: FlowModel } }) =>
      api.PUT(`${BASE}/definitions/${id}`, { body }),
    // 🔴 要 return：`mutateAsync` 才会等重取完成。不等的话设计器清掉草稿那一刻显示的还是
    // 旧的服务端数据 —— 刚存的改动「闪回」一下再出现，赶上那一下点发布还会以为没存上
    onSuccess: (_d, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: workflowKeys.definitions() }),
        qc.invalidateQueries({ queryKey: workflowKeys.definition(v.id) }),
      ]),
  })
}

export function useDeleteDefinition() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: (id: string) => api.DELETE(`${BASE}/definitions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.definitions() }),
  })
}

export function usePublishDefinition() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: (id: string) =>
      api.POST<{ published: boolean; new_version: boolean; version: { version_no: number } | null; issues: Issue[] }>(
        `${BASE}/definitions/${id}/publish`
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

export function useValidateDefinition() {
  return useMutation({
    mutationFn: (id: string) => api.POST<{ issues: Issue[] }>(`${BASE}/definitions/${id}/validate`),
  })
}

export function useSetDefinitionStatus() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.PUT(`${BASE}/definitions/${id}/status`, { body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

export type DirectoryRole = { id: string; name: string; code: string }

export const directoryRolesQuery = () =>
  queryOptions({
    queryKey: [...workflowKeys.all, 'directory', 'roles'] as const,
    queryFn: () => api.GET<DirectoryRole[]>(`${BASE}/directory/roles`),
    staleTime: 60_000,
  })

/** 发起页的流程预告：按当前填的表单试算（不写库） */
export const previewQuery = (code: string, form: FormData, selected: Record<string, string[]>) =>
  queryOptions({
    queryKey: [...workflowKeys.startForm(code), 'preview', form, selected] as const,
    queryFn: () =>
      api.POST<{ steps: ForecastStep[] }>(`${BASE}/startable/${encodeURIComponent(code)}/preview`, {
        body: { form, selected },
      }),
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  })

/**
 * 审批附件上传。走 `/sys/workflow/files`（只要登录）而不是 `/sys/files/upload` ——
 * 后者要 `sys:file:upload`，普通员工在审批里传不了。
 * 🔴 用 `uploadFile()` 不是 `api.POST`：multipart，而且成败要过信封判定（pages 分册）
 */
export function uploadAttachment(file: File): Promise<FileMeta & { id: string }> {
  return uploadFile<FileMeta & { id: string }>(`${BASE}/files`, file)
}

/**
 * 下载附件。🔴 不能做成 `<a href>`：下载地址要 Authorization 头，裸链接带不上，
 * 存下来的是 401 的 JSON（同文件页那条）。
 */
export async function downloadAttachment(id: string, name: string): Promise<void> {
  const buf = await fetchBytes(`/api/v1/sys/files/${id}/download?disposition=attachment`)
  const url = URL.createObjectURL(new Blob([buf]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type HandoverHolder = { user_id: string; name: string; active: boolean; count: number }

/** 离职交接：手上有在办待办的人。🔴 含已停用的账号 —— 离职的人通常已经停用，选人控件里选不到 */
export const handoverHoldersQuery = () =>
  queryOptions({
    queryKey: [...workflowKeys.all, 'handover'] as const,
    queryFn: () => api.GET<HandoverHolder[]>(`${BASE}/handover`),
  })

export function useHandover() {
  const qc = useQueryClient()
  return useMutation({
    // 调用处自己弹带上下文的错误：别让全局 MutationCache 再弹一条一样的（apps/web/src/app.tsx）
    meta: { suppressErrorToast: true },
    mutationFn: (body: { from_user_id: string; to_user_id: string; key: string }) =>
      api.POST<{ moved: number; skipped: { instance_id: string; title: string; reason: string }[] }>(
        `${BASE}/handover`,
        { body }
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

