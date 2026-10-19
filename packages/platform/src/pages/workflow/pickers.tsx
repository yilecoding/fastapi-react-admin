import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { Combobox } from '@admin/ui/components/combobox'

import { api } from '../../api-client/client'
import { UserSelect as BaseUserSelect, type UserSource } from '../_shared/user-select'
import { directoryDeptsQuery, workflowKeys, type DirectoryUser } from './api'

/**
 * 审批里的选人：数据走审批的通讯录接口（`/sys/workflow/directory/users`）——
 * `/sys/users` 挂着管理权限，普通员工在审批里选交接人 / 转交 / 抄送时调不了。
 */
const DIRECTORY: UserSource = {
  key: [...workflowKeys.all, 'directory', 'users'],
  search: (keyword) =>
    api.GET<DirectoryUser[]>(`/api/v1/sys/workflow/directory/users${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),
  byIds: (ids) => api.GET<DirectoryUser[]>(`/api/v1/sys/workflow/directory/users?ids=${ids.join(',')}`),
}

export function UserSelect(props: Omit<React.ComponentProps<typeof BaseUserSelect>, 'source'>) {
  return <BaseUserSelect source={DIRECTORY} {...props} />
}

/** 选部门（单选）。列出全部启用部门，按层级缩进 */
export function DeptSelect({
  value,
  onChange,
  disabled,
  testId = 'dept-select',
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
  testId?: string
}) {
  const { t } = useTranslation()
  const { data } = useQuery(directoryDeptsQuery())
  const options = React.useMemo(() => {
    const rows = data ?? []
    const children = new Map<string | null, typeof rows>()
    for (const d of rows) {
      const k = d.parent_id ?? null
      children.set(k, [...(children.get(k) ?? []), d])
    }
    const ids = new Set(rows.map((d) => d.id))
    const out: { value: string; label: string }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const d of children.get(parent) ?? []) {
        out.push({ value: d.id, label: `${'　'.repeat(depth)}${d.name}` })
        walk(d.id, depth + 1)
      }
    }
    walk(null, 0)
    // 父部门被停用的孤儿也要能选到 —— 挂在最后
    for (const d of rows) if (d.parent_id && !ids.has(d.parent_id)) out.push({ value: d.id, label: d.name })
    return out
  }, [data])

  return (
    <Combobox
      value={value}
      onValueChange={onChange}
      options={options}
      placeholder={t('选择部门')}
      searchPlaceholder={t('搜索部门')}
      emptyText={t('没有匹配的部门')}
      disabled={disabled}
      id={testId}
    />
  )
}
