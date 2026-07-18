import { IconLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'

/**
 * 权限不足。由 `requirePerm` 守卫重定向而来，
 * search 里带着来源地址和缺失的权限码，方便用户找管理员报。
 */
export function ForbiddenPage({ search }: { search?: { from?: string; need?: string } }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="grid size-14 place-content-center rounded-full bg-muted">
        <IconLock className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold" data-testid="page-title">{t('无权访问')}</h1>
        <p className="text-sm text-muted-foreground">{t('你的角色没有这个页面的访问权限。')}</p>
      </div>
      {(search?.need || search?.from) && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-left text-xs">
          {search.need && (
            <p>{t('需要权限：')}<code className="text-foreground">{search.need}</code></p>
          )}
          {search.from && (
            <p className="text-muted-foreground">{t('来源：')}<code>{search.from}</code></p>
          )}
        </div>
      )}
      <Button variant="outline" render={<a href="/dashboard" />}>{t('返回仪表盘')}</Button>
    </div>
  )
}
