import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/lib/api'

/**
 * 审批（#224 2a：审批人这一侧）—— 收件箱 · 详情 · 动作。
 *
 * 接口和 web 的审批中心是同一套（`/api/v1/sys/workflow/*`，插件 `extend = "admin"` 挂在 sys 下），
 * 全部只要登录（`DependsJwtAuth`），不看权限码：谁都可能是审批人。
 *
 * ## 🔴 为什么这里有手写类型
 *
 * 这几个接口在后端返回的是裸 `ResponseModel`，生成的 `schema.d.ts` 里 `data` 是 `unknown` ——
 * 移动端的严类型客户端推不出字段。所以响应类型照 web 的 `packages/platform/src/pages/workflow/api.ts`
 * **只抄移动端用得到的那部分**，在 `queryFn` 里断言一次。请求那一侧（路径 / 查询参数 / 请求体）照旧是推断的。
 * 后端给这些接口补上 `ResponseSchemaModel[...]` 之后，这里的断言应该删掉换成推断。
 *
 * ⚠️ 所有 ID 都是雪花**字符串**，不要 `Number()`（硬纪律 6）。
 */

export type InstanceStatus = 'running' | 'approved' | 'rejected' | 'withdrawn' | 'terminated'

export type Action =
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'transfer'
  | 'cc'
  | 'remind'
  | 'terminate'
  | 'send_back'
  | 'reassign'
  | 'take_back'
  | 'add_sign'

export type InboxTab = 'todo' | 'done' | 'initiated' | 'cc'

export type InstanceRow = {
  id: string
  title: string
  summary: string | null
  definition_name: string | null
  status: InstanceStatus
  initiator_id: string
  initiator_name: string | null
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
}

type PageData<T> = { items: T[]; total: number; page: number; size: number; total_pages: number }

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

export type FormField = {
  id: string
  type: FieldType
  label: string
  options?: { label: string; value: string }[] | null
  precision?: number | null
  multiple?: boolean
  content?: string | null
  columns?: FormField[] | null
}

export type TaskRow = {
  id: string
  node_id: string
  node_name: string
  assignee_id: string
  assignee_name: string
  /** 第几轮进入这个节点：退回之后重走同一个节点时不同，进度按「节点 + 轮次」分组 */
  batch: number
  /** 节点配了超时、待办还在办：什么时候会被提醒 / 自动处理 */
  due_time?: string | null
  /** 办理人第一次打开这张单的时间 */
  read_time?: string | null
  status: 'pending' | 'done' | 'canceled' | 'transferred'
  decision: string | null
  opinion: string | null
  created_time: string
  finished_time: string | null
}

export type RecordRow = {
  id: string
  task_id: string | null
  node_id: string | null
  action: string
  actor_type: 'user' | 'system' | 'ai'
  actor_name: string | null
  node_name: string | null
  target_user_name: string | null
  opinion: string | null
  detail: { to_name?: string; mode?: 'before' | 'after' } | null
  created_time: string
}

export type Capability = { action: Action; enabled: boolean; reason: string | null }

export type ForecastStep = {
  node_id: string
  name: string
  type: 'approval' | 'cc'
  mode: string
  users: { id: string; name: string }[]
  /** ok 有人办 · pick 发起人自选还没选 · skip 跳过 · admin 转给管理员 · reject 将被自动驳回 */
  outcome: 'ok' | 'pick' | 'skip' | 'admin' | 'reject'
  masked?: boolean
}

export type FileMeta = { name: string; size: number; ext: string }

export type InstanceDetail = {
  instance: InstanceRow & { seq: number; definition_code: string; current_node_id: string | null }
  /** 已经按当前查看人裁掉了隐藏字段（服务端做的） */
  form_schema: { fields: FormField[] }
  form_data: Record<string, unknown>
  /** 当前查看人若有待办：字段 ID → hidden / readonly / editable */
  field_perms: Record<string, string>
  /** 流程树。进度里要按节点 ID 找审批方式（或签 / 会签 / 依次）和超时动作，所以整棵留着 */
  model: { root: { id: string } & Record<string, unknown> }
  tasks: TaskRow[]
  records: RecordRow[]
  ccs: { user_id: string; user_name: string | null; read_time: string | null }[]
  capabilities: Capability[]
  my_task_id: string | null
  files: Record<string, FileMeta>
  forecast: ForecastStep[]
  /** 能退回到哪（只有当前能「退回」的人有）：第一个是发起人 */
  send_back_targets: { node_id: string; name: string }[]
  /** 依次审批的当前节点上，排在后面还没轮到的人。`masked` = 来自看不到的人员字段 */
  waiting: { id: string | null; name: string | null; masked?: boolean }[]
}

export type DirectoryUser = { id: string; nickname: string; username: string; dept_name: string | null }

const PAGE_SIZE = 20

export const workflowKeys = {
  all: ['workflow'] as const,
  inbox: (tab: InboxTab) => ['workflow', 'inbox', tab] as const,
  counts: ['workflow', 'counts'] as const,
  detail: (id: string) => ['workflow', 'detail', id] as const,
  directory: (keyword: string) => ['workflow', 'directory', keyword] as const,
}

/** 四个收件箱。路径是字面量，openapi 的路径推断要求每个都写全 —— 不要拼字符串 */
function fetchInbox(tab: InboxTab, page: number) {
  const query = { query: { page, size: PAGE_SIZE } }
  switch (tab) {
    case 'todo':
      return api.GET('/api/v1/sys/workflow/inbox/todo', { params: query })
    case 'done':
      return api.GET('/api/v1/sys/workflow/inbox/done', { params: query })
    case 'initiated':
      return api.GET('/api/v1/sys/workflow/inbox/initiated', { params: query })
    case 'cc':
      return api.GET('/api/v1/sys/workflow/inbox/cc', { params: query })
  }
}

export function useInbox(tab: InboxTab) {
  return useInfiniteQuery({
    queryKey: workflowKeys.inbox(tab),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => (await fetchInbox(tab, pageParam)) as PageData<InstanceRow>,
    // 终点判据用 `total_pages`，不用 `items.length < size`（同 `lib/users.ts`）
    getNextPageParam: (last) => (last.page < last.total_pages ? last.page + 1 : undefined),
  })
}

/** 待办数 / 抄送未读数：收件箱的 tab 角标、「应用」宫格的角标 */
export function useWorkflowCounts() {
  return useQuery({
    queryKey: workflowKeys.counts,
    queryFn: async () =>
      (await api.GET('/api/v1/sys/workflow/inbox/counts')) as { todo: number; cc_unread: number },
  })
}

export function useInstance(id: string) {
  return useQuery({
    queryKey: workflowKeys.detail(id),
    queryFn: async () =>
      (await api.GET('/api/v1/sys/workflow/instances/{pk}', { params: { path: { pk: id } } })) as InstanceDetail,
  })
}

/**
 * 选人（转交 / 抄送 / 加签 / 改办理人）。走审批自己的通讯录接口，**不是** `/sys/users` ——
 * 那个要 `sys:user:list`，普通审批人没有。
 */
export function useDirectoryUsers(keyword: string) {
  return useQuery({
    queryKey: workflowKeys.directory(keyword),
    queryFn: async () =>
      (await api.GET('/api/v1/sys/workflow/directory/users', {
        params: { query: { keyword: keyword.trim() || undefined } },
      })) as DirectoryUser[],
    placeholderData: (prev) => prev,
  })
}

/** 表单里人员字段存的是 ID：按 ID 回查名字（同 web `UserNames`） */
export function useDirectoryUsersByIds(ids: string[]) {
  const key = [...ids].sort().join(',')
  return useQuery({
    queryKey: ['workflow', 'directory-ids', key] as const,
    enabled: ids.length > 0,
    queryFn: async () =>
      (await api.GET('/api/v1/sys/workflow/directory/users', { params: { query: { ids: key } } })) as DirectoryUser[],
    staleTime: 5 * 60_000,
  })
}

/** 部门字段存的是 ID：整棵部门树拉一次（同 web `DeptName`），量很小 */
export function useDirectoryDepts(enabled: boolean) {
  return useQuery({
    queryKey: ['workflow', 'directory-depts'] as const,
    enabled,
    queryFn: async () =>
      (await api.GET('/api/v1/sys/workflow/directory/depts')) as { id: string; name: string }[],
    staleTime: 5 * 60_000,
  })
}

/**
 * 附件字段存的是文件 ID。按 ID 取文件详情，交给公告那套 `AttachmentList`（下载 / 预览 / 系统分享）。
 * 读权限后端按审批单的可见性判（web 详情的下载走的也是 `/sys/files/{id}`）。
 */
export function useFileDetails(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['files', 'detail', id] as const,
      queryFn: () => api.GET('/api/v1/sys/files/{pk}', { params: { path: { pk: id } } }),
      staleTime: 5 * 60_000,
    })),
  })
}

/**
 * 幂等键。🔴 RN 的 Hermes 上**不一定有 `crypto.randomUUID`**（web 那份在非安全上下文里也踩过），
 * 所以要有兜底；后端只要求 8–64 位。
 */
export function idempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 40)
}

export type ActBody = {
  action: Action
  opinion?: string
  target_user_ids?: string[]
  target_node_id?: string
  task_id?: string
  resume?: boolean
  sign_mode?: 'before' | 'after'
}

export function useAct(instanceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ActBody) =>
      api.POST('/api/v1/sys/workflow/instances/{pk}/actions', {
        params: { path: { pk: instanceId } },
        // `resume` 在生成的类型里是必填（后端默认 False，OpenAPI 把带默认值的字段标成了 required）
        body: { ...body, resume: body.resume ?? false, key: idempotencyKey() },
      }),
    // 🔴 成功和失败都要重取：失败多半是「已被他人处理」（409），界面要跟上真实状态（同 web）
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

/** 办理人打开了详情：记「已读」（接口只记第一次）。抄送人打开：记抄送已读，角标跟着变 */
export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; kind: 'task' | 'cc' }) =>
      v.kind === 'task'
        ? api.PUT('/api/v1/sys/workflow/instances/{pk}/read', { params: { path: { pk: v.id } } })
        : api.PUT('/api/v1/sys/workflow/instances/{pk}/cc-read', { params: { path: { pk: v.id } } }),
    onSuccess: (_d, v) => {
      // 进度里「审批中 · 已读 / 未读」要跟着变（同 web `useMarkTaskRead`）
      if (v.kind === 'task') void qc.invalidateQueries({ queryKey: workflowKeys.detail(v.id) })
      if (v.kind === 'cc') {
        void qc.invalidateQueries({ queryKey: workflowKeys.counts })
        void qc.invalidateQueries({ queryKey: workflowKeys.inbox('cc') })
      }
    },
  })
}

/** ⚠️ 值是 **key**，由使用处 `t()`。文案和 web 审批中心同一批 */
export const ACTION_TEXT: Record<Action, string> = {
  approve: '同意',
  reject: '驳回',
  withdraw: '撤回',
  transfer: '转交',
  cc: '抄送',
  remind: '催办',
  terminate: '终止',
  send_back: '退回',
  reassign: '改办理人',
  take_back: '拿回',
  add_sign: '加签',
}

export const DONE_TEXT: Record<Action, string> = {
  approve: '已同意',
  reject: '已驳回',
  withdraw: '已撤回',
  transfer: '已转交',
  cc: '已抄送',
  remind: '已催办',
  terminate: '已终止',
  send_back: '已退回',
  reassign: '已改办理人',
  take_back: '已拿回',
  add_sign: '已加签',
}

export const STATUS_TEXT: Record<InstanceStatus, string> = {
  running: '审批中',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
  terminated: '已终止',
}
