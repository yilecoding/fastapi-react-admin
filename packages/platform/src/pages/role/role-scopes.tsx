import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { IconDeviceFloppy, IconInfoCircle, IconLoader2, IconRotate } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import { usePerm } from '../../auth/use-perm'
import { StatusBadge, TONE_CLASS } from '../_shared/status'
import { allDataScopesQuery, roleScopesQuery, useUpdateRoleScopes, type Role } from './api'
import { sameSet } from './perm-tree'

/**
 * 数据范围绑定。
 *
 * `sys:role:scope:edit` 和 `PUT /roles/{id}/scopes` 建库时就在，只是一直没有界面 ——
 * 角色的「启用数据权限过滤」开着，却没地方选到底按哪个范围过滤，等于空转。
 */
export function RoleScopes({
  role,
  onDirtyChange,
}: {
  role: Role
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const editable = can('sys:role:scope:edit')

  const { data: page, isPending: loadingAll } = useQuery(allDataScopesQuery)
  const { data: owned, isPending: loadingOwned } = useQuery(roleScopesQuery(role.id))

  const scopes = page?.items ?? []
  const baseline = React.useMemo(() => new Set(owned ?? []), [owned])

  const [draft, setDraft] = React.useState<Set<string> | null>(null)
  const checked = draft ?? baseline
  const dirty = draft !== null && !sameSet(draft, baseline)
  const [error, setError] = React.useState<string | null>(null)

  const save = useUpdateRoleScopes()
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  const loading = loadingAll || loadingOwned

  const toggle = (id: string) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setError(null)
    setDraft(next)
  }

  async function handleSave() {
    setError(null)
    try {
      await save.mutateAsync({ id: role.id, scopes: [...checked] })
      setDraft(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  return (
    <div className="flex flex-col gap-3 content-scroll:lg:min-h-0 content-scroll:lg:flex-1" data-testid="role-scopes">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {editable && (
          <>
            <Button size="sm" disabled={!dirty || save.isPending} onClick={handleSave} data-testid="scope-save">
              {save.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconDeviceFloppy className="size-4" />}
              {t('保存绑定')}
            </Button>
            <Button variant="outline" size="sm" className="h-8" disabled={!dirty || save.isPending}
                    onClick={() => { setDraft(null); setError(null) }} data-testid="scope-reset">
              <IconRotate className="size-4" />{t('还原')}
            </Button>
          </>
        )}
        <span className="text-sm text-muted-foreground" data-testid="scope-count">
          {t('已绑定 {{n}} / {{total}}', { n: checked.size, total: scopes.length })}
        </span>
      </div>

      {!role.is_filter_scopes && (
        <p className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs ring-1', TONE_CLASS.warning)}
           data-testid="scope-inert">
          <IconInfoCircle className="mt-px size-3.5 shrink-0" />
          {t('该角色关闭了「启用数据权限过滤」，可以看到全量数据 —— 这里绑的范围暂时不会生效。')}
          {t('要让它生效，先在角色编辑里把开关打开。')}
        </p>
      )}

      {error && <p className="text-sm text-destructive" data-testid="scope-error">{error}</p>}

      {/* 定高时这一层就是滚动区；高度 auto 时三条都是空操作 */}
      <div className="rounded-lg border p-2 content-scroll:lg:min-h-0 content-scroll:lg:flex-1 content-scroll:lg:overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : scopes.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('还没有数据范围。先去「系统管理 › 数据权限」建一个，再回来绑定。')}
          </p>
        ) : (
          <div className="flex flex-col">
            {scopes.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
                <Checkbox
                  checked={checked.has(s.id)}
                  disabled={!editable}
                  onCheckedChange={() => toggle(s.id)}
                  data-testid={`scope-check-${s.id}`}
                  aria-label={s.name}
                />
                <span
                  className={cn('flex-1 text-sm select-none', editable && 'cursor-pointer')}
                  onClick={() => editable && toggle(s.id)}
                >
                  {s.name}
                </span>
                <StatusBadge value={s.status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
