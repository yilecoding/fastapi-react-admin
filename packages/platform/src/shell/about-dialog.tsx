import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconAlertTriangle } from '@tabler/icons-react'

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'

import { api } from '../api-client/client'

/** 前端自己的构建信息。platform 不认识 `apps/web` 的 `BRAND`，由 app 经 `HelpMenu` 传进来 */
export type AboutInfo = {
  /** 产品名 */
  name: string
  /** 带 `v` 前缀的版本号，如 `v1.1.1` */
  version: string
  /** 7 位提交号；本地没有 git / 构建时没传 `GIT_SHA` 时是 `null` */
  commit: string | null
}

type BackendBuild = { version: string; commit: string | null }

/**
 * 「关于」：前端和后端各是哪个版本、哪个提交（#378）。
 *
 * 存在的理由：线上出问题时第一个问题永远是「你用的是哪一版」，而原来界面上没有任何地方答得出来 ——
 * 登录页页脚只有前端版本号，后端的要登进服务器才看得到。现在用户截这一屏就够了。
 *
 * 🔴 **两端不一致要标出来，不能只是并排摆着。** 「旧前端 + 新后端」不产生任何前端报错
 * （见 `apps/web/src/lib/app-version.ts`），这里是它唯一看得见的地方。
 * 判定：版本号不同，或者两边**都拿得到**提交号而不同。有一边是 `null`（本地开发）不算不一致。
 *
 * 后端那一行走 `/api/v1/sys/dashboard/about`，不走不鉴权的 `/health/status`：那条的地址随部署形态变
 * （经 nginx 是 `/api/health/status`，直连后端是 `/health/status`），而且降级时是 503。
 */
export function AboutDialog({
  open,
  onOpenChange,
  about,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  about: AboutInfo
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['shell', 'about'],
    queryFn: () => api.GET<BackendBuild>('/api/v1/sys/dashboard/about'),
    enabled: open,
    // 每次打开都重新问：这一屏要答的就是「此刻线上是哪一版」，缓存住的答案在发版之后是错的
    staleTime: 0,
  })
  // 🔴 **只认这一次打开问到的答案。** 再次打开时 react-query 会留着上一次的 `data`：重查失败（发版后断网、
  // 后端 5xx）它照样在，于是这里静默显示旧的后端版本、错误块不出、「不一致」也可能该出不出（#379 评审）。
  // 所以正在取、取失败时一律当成没有 —— 上一次的值不拿来顶替，这一屏答的是「此刻」
  const backend = query.isFetching || query.isError ? undefined : query.data
  const frontendVersion = about.version.replace(/^v/, '')
  const mismatch =
    !!backend &&
    (backend.version !== frontendVersion ||
      (!!backend.commit && !!about.commit && backend.commit !== about.commit))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="about-dialog">
        <DialogHeader>
          <DialogTitle>{t('关于')}</DialogTitle>
          <DialogDescription>{about.name}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('前端')}</dt>
          <dd className="font-mono select-all" data-testid="about-frontend">
            <BuildLabel version={frontendVersion} commit={about.commit} />
          </dd>
          <dt className="text-muted-foreground">{t('后端')}</dt>
          <dd className="font-mono select-all" data-testid="about-backend">
            {backend ? (
              <BuildLabel version={backend.version} commit={backend.commit} />
            ) : query.isError && !query.isFetching ? (
              // 失败要看得见（硬纪律 9）：原因和重试在下面那一块，这里不留空也不写成「未知版本」
              <span className="font-sans text-destructive select-none">{t('获取失败')}</span>
            ) : (
              <span className="font-sans text-muted-foreground select-none">{t('加载中…')}</span>
            )}
          </dd>
        </dl>

        {query.isError && !query.isFetching && (
          <QueryError error={query.error} onRetry={() => void query.refetch()} testId="about-error" />
        )}

        {mismatch && (
          <p
            className="flex items-start gap-2 rounded-md bg-amber-100 p-2.5 text-sm text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
            role="alert"
            data-testid="about-mismatch"
          >
            <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t('前端和后端不是同一个版本。先刷新页面；刷新后仍不一致，请联系管理员确认部署是否完整。')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BuildLabel({ version, commit }: { version: string; commit: string | null }) {
  return (
    <>
      v{version}
      {commit && <span className="text-muted-foreground"> · {commit}</span>}
    </>
  )
}
