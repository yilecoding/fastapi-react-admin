import { useTranslation } from 'react-i18next'
import { Button } from "@admin/ui/components/button"

export function NotFoundPage() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="font-mono text-7xl font-bold text-muted-foreground/20">404</p>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t('页面不存在')}</h1>
        <p className="text-sm text-muted-foreground">{t('你访问的地址没有对应的页面。')}</p>
      </div>
      <Button render={<a href="/dashboard" />}>{t('回到首页')}</Button>
    </div>
  )
}
