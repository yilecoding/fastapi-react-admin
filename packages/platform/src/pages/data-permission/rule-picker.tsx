import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2, IconSearch } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@admin/ui/components/input-group'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

import { ApiError } from '../../api-client/errors'
import {
  allRulesQuery, expressionSymbol, useUpdateScopeRules, type DataScope,
} from './api'

/**
 * 「引用已有规则」—— 次要入口。
 *
 * 规则表是 m2m，理论上一条规则可以挂到多个范围。实测目前零复用，
 * 所以这个入口不是主路径，主路径是「新建规则」（建完自动挂上）。
 */
export function RulePicker({
  open, onOpenChange, scope, boundIds,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  scope: DataScope
  boundIds: string[]
}) {
  const { t } = useTranslation()
  const { data: all = [], isPending } = useQuery({ ...allRulesQuery, enabled: open })
  const [keyword, setKeyword] = React.useState('')
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [err, setErr] = React.useState<string | null>(null)

  const bind = useUpdateScopeRules()
  const bound = React.useMemo(() => new Set(boundIds), [boundIds])

  React.useEffect(() => {
    if (!open) return
    setKeyword('')
    setPicked(new Set())
    setErr(null)
  }, [open])

  const shown = React.useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.model.toLowerCase().includes(q) ||
        r.column.toLowerCase().includes(q) ||
        r.value.toLowerCase().includes(q)
    )
  }, [all, keyword])

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  async function handleBind() {
    if (picked.size === 0) return
    setErr(null)
    try {
      await bind.mutateAsync({ id: scope.id, rules: [...new Set([...boundIds, ...picked])] })
      onOpenChange(false)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="rule-picker">
        <DialogHeader>
          <DialogTitle>{t('引用已有规则到「{{name}}」', { name: scope.name })}</DialogTitle>
          <DialogDescription>
            {t('同一条规则可以挂在多个范围上。已经在本范围里的会置灰。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-4">
          <InputGroup className="h-8">
            <InputGroupAddon align="inline-start">
              <IconSearch className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              value={keyword}
              data-testid="rule-picker-search"
              placeholder={t("搜索名称 / 模型 / 字段 / 值…")}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </InputGroup>

          <div className="max-h-80 min-h-56 overflow-y-auto rounded-md border p-1" data-testid="rule-picker-list">
            {isPending ? (
              <div className="flex flex-col gap-1 p-1">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : shown.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {keyword ? t('没有匹配的规则') : t('系统里还没有任何规则，用「新建规则」建第一条')}
              </p>
            ) : (
              shown.map((r) => {
                const already = bound.has(r.id)
                return (
                  <div
                    key={r.id}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5',
                      already ? 'opacity-60' : 'hover:bg-muted/60'
                    )}
                    data-testid={`rule-picker-row-${r.id}`}
                  >
                    <Checkbox
                      checked={already || picked.has(r.id)}
                      disabled={already}
                      onCheckedChange={() => toggle(r.id)}
                      data-testid={`rule-picker-check-${r.id}`}
                      aria-label={r.name}
                    />
                    <span
                      className={cn('flex min-w-0 flex-1 flex-col', !already && 'cursor-pointer')}
                      onClick={() => !already && toggle(r.id)}
                    >
                      <span className="truncate text-sm">{r.name}</span>
                      <code className="truncate text-[11px] text-muted-foreground">
                        {r.model === '__ALL__' ? t('全部模型') : r.model}.{r.column}{' '}
                        {expressionSymbol(r.expression)} {r.value}
                      </code>
                    </span>
                    <Badge variant={r.operator === 1 ? 'secondary' : 'outline'} className="shrink-0 font-normal">
                      {r.operator === 1 ? 'OR' : 'AND'}
                    </Badge>
                    {already && <span className="shrink-0 text-xs text-muted-foreground">{t('已在本范围')}</span>}
                  </div>
                )
              })
            )}
          </div>

          <span className="text-xs text-muted-foreground" data-testid="rule-picker-count">
            {t('已选 {{n}} 条 · 系统共 {{total}} 条规则', { n: picked.size, total: all.length })}
          </span>
          {err && <p className="text-sm text-destructive" data-testid="rule-picker-error">{err}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
          <Button onClick={handleBind} disabled={picked.size === 0 || bind.isPending}
                  data-testid="rule-picker-submit">
            {bind.isPending && <IconLoader2 className="size-4 animate-spin" />}
            {picked.size > 0 ? t('引用 {{n}} 条', { n: picked.size }) : t('引用')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
