import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'

import { api, type PageData } from '../../../api-client/client'

/** 集合字段（用户的角色、角色的菜单…）里的一个成员。`label` 是提交那一刻它叫什么 */
export type DataChangeMember = { id: string | number; label: string | null }

/** 一个字段的变化（后端 `common/data_change/capture.py: _value_change` / `_set_change`） */
export type DataChangeItem = {
  field: string
  /** 字段的中文名 —— 仓库里写的，渲染处 `t(label)` */
  label: string
  old?: unknown
  new?: unknown
  /** 引用列（部门 / 上级菜单…）存 ID 也存当时的名字；固定取值的列（状态…）存取值的中文名 */
  old_label?: string
  new_label?: string
  /** 敏感列（密码）：只记「改过」，不记值 */
  secret?: boolean
  added?: DataChangeMember[]
  removed?: DataChangeMember[]
}

export type DataChangeAction = 'create' | 'update' | 'delete' | 'bulk'

export type DataChange = {
  id: string
  trace_id: string
  entity_type: string
  entity_id: string | null
  /** 对象当时的名字；批量汇总行（action = bulk）是命中的行数 */
  entity_label: string | null
  action: DataChangeAction
  changes: DataChangeItem[] | null
  actor_id: string | null
  actor_name: string | null
  source: string
  source_ref: string | null
  ip: string | null
  created_time: string
}

export type DataChangeMeta = {
  entities: { entity: string; title: string; fields: { field: string; label: string }[] }[]
  sources: { value: string; label: string }[]
  actions: { value: string; label: string }[]
}

export const dataChangeKeys = {
  all: ['logs', 'changes'] as const,
}

/** 对象类型 / 字段 / 来源的中文名。登记表只在发版时变，取一次就够 */
export const dataChangeMetaQuery = () =>
  queryOptions({
    queryKey: [...dataChangeKeys.all, 'meta'] as const,
    queryFn: () => api.GET<DataChangeMeta>('/api/v1/logs/changes/meta'),
    staleTime: Infinity,
  })

const ENTITY_PAGE_SIZE = 20

/** 某一个对象的变更记录（抽屉里滚到底取下一页） */
export const entityChangesQuery = (entity: string, id: string) =>
  infiniteQueryOptions({
    queryKey: [...dataChangeKeys.all, 'entity', entity, id] as const,
    queryFn: ({ pageParam }) =>
      api.GET<PageData<DataChange>>(
        `/api/v1/logs/changes?${new URLSearchParams({
          entity_type: entity,
          entity_id: id,
          page: String(pageParam),
          size: String(ENTITY_PAGE_SIZE),
        })}`
      ),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.total_pages ? last.page + 1 : undefined),
  })

/** 一次请求改了什么（操作日志详情里用，按 trace_id 关联） */
export const traceChangesQuery = (traceId: string) =>
  queryOptions({
    queryKey: [...dataChangeKeys.all, 'trace', traceId] as const,
    queryFn: () =>
      api.GET<PageData<DataChange>>(
        `/api/v1/logs/changes?${new URLSearchParams({ trace_id: traceId, page: '1', size: '50' })}`
      ),
  })
