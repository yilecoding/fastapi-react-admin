import * as React from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { IconLoader2 } from "@tabler/icons-react"

/**
 * 第三方登录（GitHub / Google）的落地页：后端回调重定向到这里（`OAUTH2_FRONTEND_LOGIN_REDIRECT_URI`）。
 *
 * 🔴 这条路由原来**不存在** —— 后端一直往 `/oauth2/callback` 重定向，前端落地就是 404，第三方登录从没走通过。
 *
 * - 带 `?mfa=`：账号开了二次验证（#181），后端没开会话，送去登录页接着做第二步
 * - 不带：后端已经把 refresh cookie 种好了（令牌不进 URL），直接进系统，路由守卫用 cookie 静默恢复会话
 */
export const Route = createFileRoute("/_guest/oauth2/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
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
    if (search.mfa) {
      void navigate({
        to: "/sign-in",
        search: { mfa: search.mfa, setup: search.setup === "1" ? true : undefined },
        replace: true,
      })
    } else {
      void navigate({ to: "/dashboard", replace: true })
    }
  }, [navigate, search.mfa, search.setup])

  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
      <IconLoader2 className="size-4 animate-spin" />
      {t("正在登录…")}
    </div>
  )
}
