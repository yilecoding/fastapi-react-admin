import { useTranslation } from 'react-i18next'
import { Button } from "@admin/ui/components/button"

import { isStaleAssetError } from "@/lib/app-version"

/**
 * 全局错误页。用 `-` 前缀被 routeFileIgnorePrefix 排除出路由树，
 * 但文件放在 routes/ 下就近维护。
 */
export function ErrorPage({ error }: { error?: Error }) {
  const { t } = useTranslation()

  /**
   * 🔴 「分片取不到」不是一个 500，它是**版本不一致**：这个标签页开着没刷新，
   * 而服务器上那个 hash 文件已经被新构建覆盖删除了。
   * 照旧渲染 500 + 原始错误文案，用户读到的是
   * `Failed to fetch dynamically imported module: …/assets/viewer-D3f1.js`，
   * 没人会从这句话想到「刷新一下就好了」——所以这一支单独说人话。
   */
  if (isStaleAssetError(error)) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t('已发布新版本')}</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {t('当前页面用的还是旧版前端，刷新后继续使用。')}
          </p>
        </div>
        <Button onClick={() => window.location.reload()} data-testid="stale-reload">
          {t('刷新')}
        </Button>
      </div>
    )
  }

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
