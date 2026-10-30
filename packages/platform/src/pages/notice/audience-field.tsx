import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { Label } from '@admin/ui/components/label'
import { MultiSelect, type MultiSelectOption } from '@admin/ui/components/multi-select'
import { RadioGroup, RadioGroupItem } from '@admin/ui/components/radio-group'
import { cn } from '@admin/ui/lib/utils'

import { api } from '../../api-client/client'
import { ApiError } from '../../api-client/errors'
import { UserSelect, type PickUser, type UserSource } from '../_shared/user-select'
import { allRolesQuery, deptTreeQuery, type Dept } from '../user/api'
import type { AudienceKind, NoticeAudienceEntry, NoticeAudienceItem } from './api'

/**
 * 发布范围（#190）：全员 / 指定（部门 · 角色 · 人，三样取并集）。
 *
 * 判定在看的人那一侧做（`dept_ids` = 本部门 + 所有上级），所以**选了一个部门就包含它下面所有的组** ——
 * 下拉里它的下级显示成勾着、点不动（「随上级」），存的只有被点名的那一个。
 *
 * 选择器都是现成的、绑底座接口（不绑审批插件的通讯录：公告是插件，不能依赖另一个可以卸载的插件）：
 * 部门树 `GET /sys/depts`、角色 `GET /sys/roles/all`、选人 `GET /sys/users`（同部门页选负责人那一份）。
 * ⚠️ 这三个接口各要 `sys:dept:list` / `sys:role:list` / `sys:user:list`：只有发公告权限、没有这三个的人，
 * 下拉里是一条「没有权限」的错误（硬纪律 9），而不是一个空列表 —— 后者会让人以为「没有部门可选」。
 */

export type AudienceDraft = {
  mode: 'all' | 'some'
  depts: string[]
  roles: string[]
  users: string[]
}

export const AUDIENCE_ALL: AudienceDraft = { mode: 'all', depts: [], roles: [], users: [] }

export function audienceDraftOf(items: NoticeAudienceItem[]): AudienceDraft {
  if (!items.length) return AUDIENCE_ALL
  const of = (k: AudienceKind) => items.filter((x) => x.kind === k).map((x) => String(x.target_id))
  return { mode: 'some', depts: of('dept'), roles: of('role'), users: of('user') }
}

/** 一个都没选的「指定」—— 发出去就是 `[]` = 全员，表单要拦住 */
export function audienceIsEmpty(d: AudienceDraft): boolean {
  return d.mode === 'some' && d.depts.length + d.roles.length + d.users.length === 0
}

/** 发给后端的样子。`mode: 'all'` 是 `[]`（= 全员），不是 `undefined`（= 不改） */
export function audienceEntriesOf(d: AudienceDraft): NoticeAudienceEntry[] {
  if (d.mode === 'all') return []
  return [
    ...d.depts.map((target_id) => ({ kind: 'dept' as const, target_id })),
    ...d.roles.map((target_id) => ({ kind: 'role' as const, target_id })),
    ...d.users.map((target_id) => ({ kind: 'user' as const, target_id })),
  ]
}

/** 范围有没有动过（顺序无关）。没动过的编辑**不发** `audience`，理由见 `NoticeBody.audience` */
export function sameAudience(a: AudienceDraft, b: AudienceDraft): boolean {
  const key = (d: AudienceDraft) =>
    audienceEntriesOf(d)
      .map((e) => `${e.kind}:${e.target_id}`)
      .sort()
      .join(',')
  return a.mode === b.mode && key(a) === key(b)
}

/** `/sys/users` 选人。同 `dept/form.tsx` 那份；按用户名模糊搜 */
const SYS_USERS: UserSource = {
  key: ['sys', 'user', 'pick'],
  search: async (keyword) => {
    const q = new URLSearchParams({ page: '1', size: '20' })
    if (keyword) q.set('username', keyword)
    const res = await api.GET<{ items: (PickUser & { dept?: { name: string } | null })[] }>(`/api/v1/sys/users?${q}`)
    return res.items.map((u) => ({ id: u.id, nickname: u.nickname, username: u.username, dept_name: u.dept?.name ?? null }))
  },
}

export function NoticeAudienceField({
  value,
  onChange,
  known,
  lockedToAll,
  error,
}: {
  value: AudienceDraft
  onChange: (next: AudienceDraft) => void
  /** 编辑时后端给的显示名（部门 / 角色已删的话下拉里查不到，靠它显示；删了的 `name` 是 `null`） */
  known: NoticeAudienceItem[]
  /** 「登录页可见」开着：不登录的人都看得到，限定范围自相矛盾（后端 422），只能全员 */
  lockedToAll: boolean
  error?: string
}) {
  const { t } = useTranslation()
  const some = value.mode === 'some'

  return (
    <div className="flex flex-col gap-3" data-testid="n-audience">
      <RadioGroup
        value={value.mode}
        onValueChange={(v) => onChange({ ...value, mode: v as AudienceDraft['mode'] })}
        className="flex flex-wrap gap-x-6 gap-y-2"
      >
        <Label className="flex items-center gap-2 font-normal">
          <RadioGroupItem value="all" data-testid="n-audience-all" />
          {t('全员')}
        </Label>
        <Label className={cn('flex items-center gap-2 font-normal', lockedToAll && !some && 'text-muted-foreground')}>
          {/* 已经是「指定」时不禁用：让人还能切回「全员」或者看见自己选了什么（表单另外报错） */}
          <RadioGroupItem value="some" disabled={lockedToAll && !some} data-testid="n-audience-some" />
          {t('指定部门 / 角色 / 人员')}
        </Label>
      </RadioGroup>

      {lockedToAll && !some && (
        <p className="text-xs text-muted-foreground" data-testid="n-audience-locked">
          {t('「登录页可见」开着：不登录的人都看得到，不能再限定范围。要限定范围，先关掉它。')}
        </p>
      )}

      {some && (
        <div className="grid gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-3">
          <AudienceSlot label={t('部门（含下级）')}>
            <DeptMulti value={value.depts} known={known} onChange={(depts) => onChange({ ...value, depts })} />
          </AudienceSlot>
          <AudienceSlot label={t('角色')}>
            <RoleMulti value={value.roles} known={known} onChange={(roles) => onChange({ ...value, roles })} />
          </AudienceSlot>
          <AudienceSlot label={t('人员')}>
            <UserSelect
              multiple
              source={SYS_USERS}
              value={value.users}
              onChange={(users) => onChange({ ...value, users })}
              labels={Object.fromEntries(
                known.filter((x) => x.kind === 'user').map((x) => [String(x.target_id), x.name ?? t('（已删除的用户）')])
              )}
              placeholder={t('搜索并选择人员')}
              testId="n-audience-users"
            />
          </AudienceSlot>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            {t('三样取并集：命中任意一项的人都看得到。选了部门就包含它下面所有的组，之后新建的下级组也自动在内。')}
          </p>
        </div>
      )}

      {error && (
        <span className="text-xs text-destructive" data-testid="n-audience-error">
          {error}
        </span>
      )}
    </div>
  )
}

function AudienceSlot({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** 取不到选项时的那一行（403 是「没有权限查看」，见文件头） */
function OptionsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  const forbidden = error instanceof ApiError && error.httpStatus === 403
  return (
    <span className="text-xs text-destructive">
      {forbidden ? t('没有权限查看这些数据') : t('加载失败')}
      {!forbidden && (
        <button type="button" onClick={onRetry} className="ms-1 underline underline-offset-2">
          {t('重试')}
        </button>
      )}
    </span>
  )
}

/** 部门树拍平成带层级的选项；记下每个部门的所有上级，用来判「随上级」 */
function flatten(tree: Dept[]) {
  const options: { id: string; name: string; depth: number; ancestors: string[] }[] = []
  const walk = (nodes: Dept[], depth: number, ancestors: string[]) => {
    for (const d of nodes) {
      options.push({ id: d.id, name: d.name, depth, ancestors })
      if (d.children?.length) walk(d.children, depth + 1, [...ancestors, d.id])
    }
  }
  walk(tree, 0, [])
  return options
}

function DeptMulti({
  value,
  known,
  onChange,
}: {
  value: string[]
  known: NoticeAudienceItem[]
  onChange: (v: string[]) => void
}) {
  const { t } = useTranslation()
  const query = useQuery(deptTreeQuery)
  const flat = React.useMemo(() => flatten(query.data ?? []), [query.data])
  const ancestorsOf = React.useMemo(() => new Map(flat.map((d) => [d.id, d.ancestors])), [flat])

  const options = React.useMemo<MultiSelectOption[]>(() => {
    const picked = new Set(value)
    const out: MultiSelectOption[] = flat.map((d) => {
      // 上级已经选了：它本来就在范围里，再勾一次只是往受众表里多存一行
      const covered = d.ancestors.some((a) => picked.has(a))
      return {
        value: d.id,
        label: d.name,
        depth: d.depth,
        disabled: covered,
        hint: covered ? t('随上级') : undefined,
      }
    })
    // 范围里点过、但树里已经没有的（部门删了）：照样列出来，能看见、能去掉
    const inTree = new Set(flat.map((d) => d.id))
    for (const id of value) {
      if (inTree.has(id)) continue
      const name = known.find((x) => x.kind === 'dept' && String(x.target_id) === id)?.name
      out.push({ value: id, label: name ?? t('（已删除的部门）') })
    }
    return out
  }, [flat, value, known, t])

  // 选了上级之后，它下面原来单独选过的就不用再存了（存了也不错，只是多余的行）
  const normalize = (next: string[]) => {
    const set = new Set(next)
    return next.filter((id) => !(ancestorsOf.get(id) ?? []).some((a) => set.has(a)))
  }

  return (
    <div className="flex flex-col gap-1">
      <MultiSelect
        value={value}
        onValueChange={(v) => onChange(normalize(v))}
        options={options}
        placeholder={t('选择部门')}
        searchPlaceholder={t('搜索部门')}
        emptyText={query.isPending ? t('加载中…') : t('没有匹配的部门')}
        // 「全选」在树上没有意义：选上所有根部门就是全员，那该用上面的「全员」
        showBulk={false}
        searchable
        data-testid="n-audience-depts"
        aria-label={t('部门（含下级）')}
      />
      {query.error && <OptionsError error={query.error} onRetry={() => void query.refetch()} />}
    </div>
  )
}

function RoleMulti({
  value,
  known,
  onChange,
}: {
  value: string[]
  known: NoticeAudienceItem[]
  onChange: (v: string[]) => void
}) {
  const { t } = useTranslation()
  const query = useQuery(allRolesQuery)
  const options = React.useMemo<MultiSelectOption[]>(() => {
    const rows = query.data ?? []
    // 停用的角色在「看的人」那一侧不算数（后端 `role_ids` 只取启用的），点了也命中不了任何人 —— 标出来
    const out: MultiSelectOption[] = rows.map((r) => ({
      value: r.id,
      label: r.name,
      hint: r.status === 1 ? undefined : t('已停用'),
    }))
    const have = new Set(rows.map((r) => r.id))
    for (const id of value) {
      if (have.has(id)) continue
      const name = known.find((x) => x.kind === 'role' && String(x.target_id) === id)?.name
      out.push({ value: id, label: name ?? t('（已删除的角色）') })
    }
    return out
  }, [query.data, value, known, t])

  return (
    <div className="flex flex-col gap-1">
      <MultiSelect
        value={value}
        onValueChange={onChange}
        options={options}
        placeholder={t('选择角色')}
        searchPlaceholder={t('搜索角色')}
        emptyText={query.isPending ? t('加载中…') : t('没有匹配的角色')}
        showBulk={false}
        data-testid="n-audience-roles"
        aria-label={t('角色')}
      />
      {query.error && <OptionsError error={query.error} onRetry={() => void query.refetch()} />}
    </div>
  )
}
