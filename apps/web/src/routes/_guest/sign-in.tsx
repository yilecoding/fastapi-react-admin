import * as React from "react"
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useQueryClient } from "@tanstack/react-query"
import {
  IconAlertTriangle,
  IconArrowRight,
  IconDeviceMobile,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader2,
  IconLock,
  IconQrcode,
  IconShieldCheck,
  IconUser,
} from "@tabler/icons-react"

import { login } from "@admin/platform/auth/session"
import { ApiError } from "@admin/platform/api-client/errors"
import { Button } from "@admin/ui/components/button"
import { Checkbox } from "@admin/ui/components/checkbox"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@admin/ui/components/input-group"
import { Label } from "@admin/ui/components/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@admin/ui/components/tabs"

import { LanguageMenu } from "@/components/language-menu"
import { ThemeMenu } from "@/components/theme-menu"
import { BRAND } from "@/lib/brand"
import { SignInBrandPanel, SignInBrandStrip } from "@/routes/_guest/-sign-in-brand"

export const Route = createFileRoute("/_guest/sign-in")({
  validateSearch: (s: Record<string, unknown>) => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  component: SignInPage,
})

/** 「记住账号」只记账号，不记凭据 —— 密码和 token 不该落在 localStorage 里 */
const REMEMBER_KEY = "admin:last-username"

function readRemembered(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? ""
  } catch {
    return ""
  }
}

function writeRemembered(username: string | null) {
  try {
    if (username) localStorage.setItem(REMEMBER_KEY, username)
    else localStorage.removeItem(REMEMBER_KEY)
  } catch {
    /* 存不下不影响登录，只是下次要重新敲一遍账号 */
  }
}

const METHODS = [
  { value: "password", label: "密码登录", icon: IconKey },
  { value: "phone", label: "手机登录", icon: IconDeviceMobile },
  { value: "qrcode", label: "扫码登录", icon: IconQrcode },
] as const

type Method = (typeof METHODS)[number]["value"]

function SignInPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const router = useRouter()
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [method, setMethod] = React.useState<Method>("password")
  // 惰性初始化而不是 useRef(...).current —— 后者是在 render 里读 ref
  // 开发期预填省得每次敲；生产构建里不带默认凭据
  const [username, setUsername] = React.useState(() => readRemembered() || (import.meta.env.DEV ? "admin" : ""))
  const [password, setPassword] = React.useState(() => (import.meta.env.DEV ? "123456" : ""))
  const [showPassword, setShowPassword] = React.useState(false)
  const [remember, setRemember] = React.useState(() => readRemembered() !== "")
  const [captcha, setCaptcha] = React.useState("")
  const [captchaImg, setCaptchaImg] = React.useState<string | null>(null)
  const [captchaUuid, setCaptchaUuid] = React.useState<string | null>(null)
  // loading=拉取中 ready=已拿到 off=服务端关闭了验证码 error=拉取失败
  const [captchaState, setCaptchaState] = React.useState<"loading" | "ready" | "off" | "error">("loading")
  const [captchaError, setCaptchaError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  // 单飞：/auth/captcha 限流 5 次 / 30 秒，而 StrictMode 开发期会把 effect 跑两遍。
  // 不去重的话每次开页要吃掉 2 次配额，刷新三次就把自己限流锁死。
  const inFlight = React.useRef(false)
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadCaptcha = React.useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setCaptchaState("loading")
    setCaptchaError(null)
    try {
      const { api } = await import("@admin/platform/api-client/client")
      const res = await api.GET<{
        is_enabled: boolean
        expire_seconds: number
        uuid: string
        image: string
      }>("/api/v1/auth/captcha")
      if (!alive.current) return
      if (!res.is_enabled) {
        setCaptchaImg(null)
        setCaptchaUuid(null)
        setCaptchaState("off")
        return
      }
      // fast_captcha 返回的是不带前缀的 base64 png
      setCaptchaImg(`data:image/png;base64,${res.image}`)
      setCaptchaUuid(res.uuid)
      setCaptcha("")
      setCaptchaState("ready")
    } catch (err) {
      if (!alive.current) return
      // 关键：不能静默隐藏验证码框 —— 后端仍会强制校验，
      // 用户会拿到一个怎么点都登不进去、且没有任何提示的表单。
      setCaptchaImg(null)
      setCaptchaUuid(null)
      setCaptchaState("error")
      setCaptchaError(
        err instanceof ApiError ? err.message : t("验证码获取失败，请点击重试")
      )
    } finally {
      inFlight.current = false
    }
    // t 进依赖：切语言后这条兜底错误文案要跟着变。
    // 它变了会重建 loadCaptcha，但下面那个 effect 有 inFlight 单飞挡着，不会多打一次接口。
  }, [t])

  React.useEffect(() => {
    // 挂载即取验证码。规则想让这类取数走 useQuery，但这里要的正是
    // inFlight ref 那种「跨 StrictMode 双跑也只发一次」的单飞（见 loadCaptcha 注释），
    // 改成 query 得连带重做 loading/ready/off/error 那套状态机。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCaptcha()
  }, [loadCaptcha])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setPending(true)
    const name = username.trim()
    try {
      await login(qc, {
        username: name,
        password,
        ...(captchaUuid ? { uuid: captchaUuid, captcha } : {}),
      })
      writeRemembered(remember ? name : null)
      await router.invalidate()
      await navigate({ to: search.redirect ?? "/dashboard" })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("登录失败，请稍后重试"))
      // 🔴 命中登录限流（429）时**不要**重拉验证码。
      // /auth/captcha 自己也有配额（5 次 / 30 秒），而这里原来是「任何失败都重拉」——
      // 用户被登录限流挡住后连点几下，验证码接口也跟着被打满，于是拿到一个
      // 「验证码加载失败 + 登录也进不去」的双重死锁，且两条提示都不说明真正原因。
      // 验证码本身没被消费掉，继续用旧的即可。
      if (!(err instanceof ApiError && err.isRateLimited)) {
        void loadCaptcha()
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="min-h-svh bg-background lg:grid lg:h-svh lg:grid-cols-2 xl:grid-cols-[1.1fr_1fr]">
      <SignInBrandPanel />

      <main className="flex min-h-svh flex-col px-6 py-5 sm:px-10 lg:min-h-0 lg:overflow-y-auto">
        <div className="flex shrink-0 items-center justify-end gap-1">
          <ThemeMenu />
          <LanguageMenu />
        </div>

        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-[400px]">
            <SignInBrandStrip />

            <p className="font-mono text-2xs tracking-[0.32em] text-muted-foreground">SIGN IN</p>
            <h1 className="mt-3 text-2xl leading-tight font-semibold tracking-[-0.02em]">{t("欢迎回来")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("用管理员账号登录，进入你的工作台。")}</p>

            {/* 三个面板给同一个 min-h：切登录方式时「欢迎回来」不会上下跳 */}
            <Tabs value={method} onValueChange={(v) => setMethod(v as Method)} className="mt-7">
              {/* 下划线页签而不是胶囊组：胶囊是 shadcn 的默认长相，一眼就是模板 */}
              <TabsList variant="line" className="h-auto w-full justify-start gap-6 rounded-none border-b border-border p-0">
                {METHODS.map((m) => (
                  <TabsTrigger
                    key={m.value}
                    value={m.value}
                    data-testid={`method-${m.value}`}
                    // 基础类带 group-data-horizontal 变体，覆盖必须带同样的前缀，否则选择器优先级不够
                    className="flex-none rounded-none px-0 pb-3 text-sm group-data-horizontal/tabs:after:bottom-[-1px]"
                  >
                    <m.icon />
                    {t(m.label)}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="password" className="min-h-[22.5rem]">
                <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="username" className="text-sm">{t("账号")}</Label>
                    <InputGroup className="h-11">
                      <InputGroupAddon align="inline-start">
                        <IconUser />
                      </InputGroupAddon>
                      <InputGroupInput
                        id="username"
                        data-testid="username"
                        placeholder={t("请输入账号")}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        autoComplete="username"
                      />
                    </InputGroup>
                  </div>

                  <div className="grid gap-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <Label htmlFor="password" className="text-sm">{t("密码")}</Label>
                      {/* 后端没有自助重置（PUT /users/{pk}/password 要超管），所以这里不放假链接 */}
                      <span className="text-xs text-muted-foreground">{t("忘记密码找管理员重置")}</span>
                    </div>
                    <InputGroup className="h-11">
                      <InputGroupAddon align="inline-start">
                        <IconLock />
                      </InputGroupAddon>
                      <InputGroupInput
                        id="password"
                        data-testid="password"
                        type={showPassword ? "text" : "password"}
                        placeholder={t("请输入密码")}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete="current-password"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          size="icon-xs"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? t("隐藏密码") : t("显示密码")}
                          title={showPassword ? t("隐藏密码") : t("显示密码")}
                          data-testid="password-visibility"
                        >
                          {showPassword ? <IconEyeOff /> : <IconEye />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </div>

                  {captchaState !== "off" && (
                    <div className="grid gap-2">
                      <Label htmlFor="captcha" className="text-sm">{t("验证码")}</Label>
                      <div className="flex items-center gap-2">
                        <InputGroup className="h-11 flex-1">
                          <InputGroupAddon align="inline-start">
                            <IconShieldCheck />
                          </InputGroupAddon>
                          <InputGroupInput
                            id="captcha"
                            data-testid="captcha"
                            data-captcha-uuid={captchaUuid ?? ""}
                            placeholder={t("请输入图形验证码")}
                            value={captcha}
                            onChange={(e) => setCaptcha(e.target.value)}
                            disabled={captchaState !== "ready"}
                            autoComplete="off"
                          />
                        </InputGroup>
                        <button
                          type="button"
                          onClick={() => void loadCaptcha()}
                          data-testid="captcha-refresh"
                          disabled={captchaState === "loading"}
                          // 验证码图本身是白底 —— 深色下强行反色会压掉某些字色的对比度，所以底一律留白，靠描边让它看起来是一块「纸样」而不是漏出来的白块
                          className="flex h-11 w-[108px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-border text-xs text-muted-foreground transition-opacity hover:opacity-90 disabled:opacity-60 dark:text-neutral-600"
                          title={t("点击刷新")}
                        >
                          {captchaState === "ready" && captchaImg ? (
                            <img src={captchaImg} alt={t("验证码")} className="h-full w-full object-contain" />
                          ) : captchaState === "loading" ? (
                            <IconLoader2 className="size-4 animate-spin" />
                          ) : (
                            t("点击重试")
                          )}
                        </button>
                      </div>
                      {captchaState === "error" && (
                        <p data-testid="captcha-error" className="text-sm text-destructive">
                          {captchaError}
                        </p>
                      )}
                    </div>
                  )}

                  {error && (
                    <p
                      data-testid="login-error"
                      className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20"
                    >
                      <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
                      {error}
                    </p>
                  )}

                  <Button
                    type="submit"
                    size="lg"
                    className="mt-2 h-11 w-full text-base"
                    disabled={pending || captchaState === "loading" || captchaState === "error"}
                    data-testid="submit"
                  >
                    {pending && <IconLoader2 className="size-4 animate-spin" />}
                    {t("登录")}
                    <IconArrowRight className="transition-transform group-hover/button:translate-x-0.5" />
                  </Button>

                  <Label className="mt-1 flex w-fit items-center gap-2 text-sm font-normal text-muted-foreground">
                    <Checkbox
                      checked={remember}
                      onCheckedChange={(v) => setRemember(v === true)}
                      data-testid="remember"
                    />
                    {t("记住账号")}
                  </Label>
                </form>
              </TabsContent>

              <TabsContent value="phone" className="min-h-[22.5rem]">
                <NotWired
                  icon={IconDeviceMobile}
                  title={t("手机验证码登录还没接入")}
                  hint={t("后端目前只开了账号密码这一条登录路径，手机号验证码要等短信通道接进来。")}
                  onUsePassword={() => setMethod("password")}
                />
              </TabsContent>

              <TabsContent value="qrcode" className="min-h-[22.5rem]">
                <NotWired
                  icon={IconQrcode}
                  title={t("扫码登录还没接入")}
                  hint={t("扫码需要一个能派发登录票据的移动端，现在还没有。")}
                  onUsePassword={() => setMethod("password")}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>

        <footer className="shrink-0">
          <div className="h-px bg-border/70" />
          <div className="flex items-center justify-between gap-3 pt-3.5 pb-1 font-mono text-2xs tracking-[0.18em] text-muted-foreground">
            <span>{BRAND.wordmark}</span>
            <span>
              © {new Date().getFullYear()} · {BRAND.version}
            </span>
          </div>
        </footer>
      </main>
    </div>
  )
}

/** 还没接入的登录方式：说清楚为什么不能用，并把人送回能用的那条路 */
function NotWired({
  icon: Icon,
  title,
  hint,
  onUsePassword,
}: {
  icon: typeof IconQrcode
  title: string
  hint: string
  onUsePassword: () => void
}) {
  // NotWired 自己是组件，直接取 t()，不用让调用方传文案
  const { t } = useTranslation()
  return (
    <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/30 px-6 py-9 text-center">
      <Icon className="mx-auto size-5 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[17rem] text-sm leading-relaxed text-muted-foreground">{hint}</p>
      <Button variant="outline" size="sm" className="mt-5" onClick={onUsePassword}>
        {t("改用密码登录")}
      </Button>
    </div>
  )
}
