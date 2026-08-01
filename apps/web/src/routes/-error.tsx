import { useTranslation } from 'react-i18next'
import { Button } from "@admin/ui/components/button"

/**
 * 全局错误页。用 `-` 前缀被 routeFileIgnorePrefix 排除出路由树，
 * 但文件放在 routes/ 下就近维护。
 */
export function ErrorPage({ error }: { error?: Error }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="font-mono text-7xl font-bold text-muted-foreground/20">500</p>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t('出错了')}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {error?.message ?? t('页面渲染时发生未预期的错误。')}
        </p>
      </div>
      {/* 注意：这里不能用 <Link> —— 它可能渲染在 router 之外 */}
      <Button render={<a href="/dashboard" />}>{t('回到首页')}</Button>
    </div>
  )
}
