import * as React from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { IconLoader2 } from "@tabler/icons-react"
import { Button } from "@admin/ui/components/button"
import { isAuthenticated } from "@admin/platform/auth/session"

/**
 * 第三方登录（GitHub / Google）的落地页：后端回调重定向到这里（`OAUTH2_FRONTEND_LOGIN_REDIRECT_URI`）。
 *
 * 🔴 这条路由原来**不存在** —— 后端一直往 `/oauth2/callback` 重定向，前端落地就是 404，第三方登录从没走通过。
 *
 * - 带 `?error=`：后端拒绝了这次登录 / 绑定（陌生账号没开自动建号、账号被锁、state 失效…），显示原因（硬纪律 9）
 * - 带 `?mfa=`：账号开了二次验证（#181），后端没开会话，送去登录页接着做第二步
 * - 都不带：后端已经把 refresh cookie 种好了（令牌不进 URL），直接进系统，路由守卫用 cookie 静默恢复会话
 *
 * ⚠️ **不放在 `_guest` 下面**：绑定流程失败也落到这里，而发起绑定的人是已登录的 ——
 * `_guest` 的守卫会把他踢回工作台，错误原因就被静默吞掉了。
 */
export const Route = createFileRoute("/oauth2/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    error: typeof s.error === "string" ? s.error : undefined,
    mfa: typeof s.mfa === "string" ? s.mfa : undefined,
    setup: s.setup === "1" || s.setup === 1 ? "1" : undefined,
  }),
  component: OAuth2Callback,
})

function OAuth2Callback() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = Route.useSearch()

  React.useEffect(() => {
    if (search.error !== undefined) return
    if (search.mfa) {
      void navigate({
        to: "/sign-in",
        search: { mfa: search.mfa, setup: search.setup === "1" ? true : undefined },
        replace: true,
      })
    } else {
      void navigate({ to: "/dashboard", replace: true })
    }
  }, [navigate, search.error, search.mfa, search.setup])

  if (search.error !== undefined) {
    const signedIn = isAuthenticated()
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center" data-testid="oauth2-error">
        <div className="max-w-md space-y-1">
          <h1 className="text-lg font-semibold">{t("第三方登录没有完成")}</h1>
          <p className="text-sm text-muted-foreground">{search.error || t("服务端没有给出原因，请稍后重试。")}</p>
        </div>
        <Button render={<a href={signedIn ? "/profile" : "/sign-in"} />}>
          {signedIn ? t("返回个人中心") : t("返回登录")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
      <IconLoader2 className="size-4 animate-spin" />
      {t("正在登录…")}
    </div>
  )
}
