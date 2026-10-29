import * as React from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { IconArrowLeft, IconArrowRight, IconLoader2, IconShieldLock } from "@tabler/icons-react"

import { ApiError } from "@admin/platform/api-client/errors"
import { QrCode } from "@admin/platform/auth/mfa/qr-code"
import { RecoveryCodes } from "@admin/platform/auth/mfa/recovery-codes"
import {
  enrollMfa,
  fetchMfaSetup,
  verifyMfa,
  type MfaChallenge,
  type MfaSetupInfo,
} from "@admin/platform/auth/session"
import { Alert } from "@admin/ui/components/alert"
import { Button } from "@admin/ui/components/button"
import { CopyButton } from "@admin/ui/components/copy-button"
import { Input } from "@admin/ui/components/input"
import { Label } from "@admin/ui/components/label"
import { Skeleton } from "@admin/ui/components/skeleton"

/**
 * 登录第二步（#181）：密码 / 手机验证码 / 第三方登录都过了，还差动态码。
 *
 * - 已绑定：输认证器上的 6 位码，手机不在身边时可以填一个恢复码
 * - 被强制但还没绑：扫码 → 输一次码确认 → **先给人看恢复码**，点了「已保存」才进系统。
 *   顺序不能反：`finish` 一调路由守卫就把人带走，恢复码就再也看不到了
 */
export function MfaStep({
  challenge,
  onDone,
  onBack,
}: {
  challenge: MfaChallenge
  onDone: () => Promise<void> | void
  onBack: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [otp, setOtp] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [enrolled, setEnrolled] = React.useState<{ codes: string[]; finish: () => void } | null>(null)
  // 绑定用的密钥：一个令牌只取一次（不重取 —— 每取一次服务端就换一把新密钥，扫过的那把就作废了）
  const setupQuery = useQuery({
    queryKey: ["mfa-setup", challenge.mfaToken],
    queryFn: () => fetchMfaSetup(challenge.mfaToken),
    enabled: challenge.mfaSetup,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const setup: MfaSetupInfo | undefined = setupQuery.data

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      if (challenge.mfaSetup) {
        const { recoveryCodes, finish } = await enrollMfa(challenge.mfaToken, otp.trim())
        setEnrolled({ codes: recoveryCodes, finish: () => finish(qc) })
      } else {
        await verifyMfa(qc, challenge.mfaToken, otp.trim())
        await onDone()
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("验证失败，请稍后重试"))
      setOtp("")
    } finally {
      setPending(false)
    }
  }

  if (enrolled) {
    return (
      <div className="mt-6 flex flex-col gap-4" data-testid="mfa-enrolled">
        <p className="text-sm font-medium">{t("二次验证已开启")}</p>
        <RecoveryCodes codes={enrolled.codes} />
        <Button
          className="h-11"
          onClick={async () => {
            enrolled.finish()
            await onDone()
          }}
          data-testid="mfa-enter"
        >
          {t("我已保存，进入系统")}
          <IconArrowRight />
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4" data-testid="mfa-step">
      <div className="flex items-start gap-3">
        <IconShieldLock className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            {challenge.mfaSetup ? t("这个账号必须开启二次验证") : t("二次验证")}
          </p>
          <p className="text-sm text-muted-foreground">
            {challenge.mfaSetup
              ? t("用认证器（Google Authenticator、Microsoft Authenticator、1Password 等）扫下面的二维码，再输入它显示的 6 位码。")
              : t("输入认证器上的 6 位动态码。手机不在身边时，可以填一个恢复码。")}
          </p>
        </div>
      </div>

      {challenge.mfaSetup ? (
        setupQuery.error ? (
          <Alert tone="danger">
            {setupQuery.error instanceof ApiError ? setupQuery.error.message : t("加载失败，请重试")}{" "}
            <button type="button" className="underline" onClick={() => void setupQuery.refetch()}>
              {t("重试")}
            </button>
          </Alert>
        ) : !setup ? (
          <Skeleton className="mx-auto size-44" />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <QrCode value={setup.otpauth_uri} />
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{t("扫不了就手动输入")}</span>
              <code className="font-mono" data-testid="mfa-secret">
                {setup.totp_secret}
              </code>
              <CopyButton text={setup.totp_secret} label={t("复制密钥")} className="size-6" />
            </div>
          </div>
        )
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="mfa-otp" className="text-sm">
          {t("动态码")}
        </Label>
        <Input
          id="mfa-otp"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          autoComplete="one-time-code"
          autoFocus
          maxLength={16}
          placeholder="123456"
          className="h-11 font-mono tracking-widest"
          data-testid="mfa-otp"
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="mfa-error">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="h-11" disabled={pending || otp.trim().length < 6} data-testid="mfa-submit">
        {pending ? <IconLoader2 className="animate-spin" /> : null}
        {challenge.mfaSetup ? t("绑定并登录") : t("验证")}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack} data-testid="mfa-back">
        <IconArrowLeft />
        {t("返回重新登录")}
      </Button>
    </form>
  )
}
