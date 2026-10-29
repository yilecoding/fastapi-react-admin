import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'
import { Input } from '@admin/ui/components/input'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { ApiError } from '../../api-client/errors'
import { QrCode } from '../../auth/mfa/qr-code'
import { RecoveryCodes } from '../../auth/mfa/recovery-codes'
import { StatusPill } from '../_shared/status'
import { mfaStatusQuery, useMfaDisable, useMfaEnable, useMfaRegenerate, useMfaSetup } from './api'

type Mode = 'idle' | 'setup' | 'disable' | 'regenerate'

/**
 * 个人中心「安全」里的二次验证（#181）：开启 · 重新生成恢复码 · 关闭。
 *
 * - 开启要**扫完码再输一次动态码**才算数：只扫不确认的话，认证器没存上就把自己锁在外面
 * - 恢复码**只显示这一次**，所以开启 / 重新生成之后停在恢复码那一屏，点「完成」才收起
 * - 被策略强制的人没有「关闭」：关了下次登录又被逼着绑，白折腾
 */
export function MfaBlock() {
  const { t } = useTranslation()
  const status = useQuery(mfaStatusQuery)
  const setup = useMfaSetup()
  const enable = useMfaEnable()
  const disable = useMfaDisable()
  const regenerate = useMfaRegenerate()
  const [mode, setMode] = React.useState<Mode>('idle')
  const [otp, setOtp] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [codes, setCodes] = React.useState<string[] | null>(null)

  function reset(next: Mode = 'idle') {
    setMode(next)
    setOtp('')
    setError(null)
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('操作失败，请稍后重试'))
      setOtp('')
      return null
    }
  }

  if (status.error) return <QueryError error={status.error} onRetry={() => void status.refetch()} />
  if (!status.data) return <Skeleton className="h-16" />
  const s = status.data

  if (codes) {
    return (
      <div className="flex max-w-md flex-col gap-3">
        <RecoveryCodes codes={codes} />
        <Button className="self-start" onClick={() => setCodes(null)} data-testid="mfa-codes-done">
          {t('我已保存')}
        </Button>
      </div>
    )
  }

  const otpForm = (label: string, onSubmit: () => Promise<void>, busy: boolean, testId: string) => (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit()
      }}
      className="flex max-w-md flex-col gap-2"
    >
      <div className="flex gap-2">
        <Input
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          autoComplete="one-time-code"
          autoFocus
          maxLength={16}
          placeholder={t('认证器上的 6 位码')}
          className="font-mono tracking-widest"
          data-testid="mfa-otp"
        />
        <Button type="submit" disabled={busy || otp.trim().length < 6} data-testid={testId}>
          {label}
        </Button>
        <Button type="button" variant="ghost" onClick={() => reset()}>
          {t('取消')}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" data-testid="mfa-error">
          {error}
        </p>
      ) : null}
    </form>
  )

  if (!s.enabled) {
    if (!s.available) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="mfa-unavailable">
          {t('服务器没有配置 MFA_SECRET_KEY，暂时不能开启二次验证。请联系管理员。')}
        </p>
      )
    }
    if (mode === 'setup' && setup.data) {
      return (
        <div className="flex flex-col gap-3" data-testid="mfa-setup">
          <p className="text-sm text-muted-foreground">
            {t('用认证器（Google Authenticator、Microsoft Authenticator、1Password 等）扫这个二维码，再输入它显示的 6 位码确认。')}
          </p>
          <QrCode value={setup.data.otpauth_uri} />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('扫不了就手动输入')}</span>
            <code className="font-mono" data-testid="mfa-secret">
              {setup.data.totp_secret}
            </code>
            <CopyButton text={setup.data.totp_secret} label={t('复制密钥')} className="size-6" />
          </div>
          {otpForm(
            t('确认开启'),
            async () => {
              const res = await run(() => enable.mutateAsync(otp.trim()))
              if (res) {
                reset()
                setCodes(res.recovery_codes)
              }
            },
            enable.isPending,
            'mfa-enable-confirm'
          )}
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-3">
        {s.enforced ? (
          <Alert tone="warning">{t('管理员要求你的账号开启二次验证。现在开启，或者下次登录时按提示绑定。')}</Alert>
        ) : null}
        <div className="flex items-center gap-3">
          <StatusPill tone="muted">{t('未开启')}</StatusPill>
          <Button
            size="sm"
            disabled={setup.isPending}
            onClick={async () => {
              const res = await run(() => setup.mutateAsync())
              if (res) reset('setup')
            }}
            data-testid="mfa-enable"
          >
            {t('开启二次验证')}
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="mfa-enabled">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatusPill tone="success">{t('已开启')}</StatusPill>
        <span className="text-muted-foreground">
          {t('开启于 {{time}} · 还剩 {{n}} 个恢复码', {
            time: formatDateTime(s.enabled_time),
            n: s.recovery_remaining,
          })}
        </span>
      </div>
      {s.recovery_remaining <= 3 ? (
        <Alert tone="warning">{t('恢复码快用完了，建议重新生成一批。')}</Alert>
      ) : null}
      {mode === 'regenerate' ? (
        otpForm(
          t('重新生成'),
          async () => {
            const res = await run(() => regenerate.mutateAsync(otp.trim()))
            if (res) {
              reset()
              setCodes(res.recovery_codes)
            }
          },
          regenerate.isPending,
          'mfa-regenerate-confirm'
        )
      ) : mode === 'disable' ? (
        otpForm(
          t('确认关闭'),
          async () => {
            const res = await run(() => disable.mutateAsync(otp.trim()).then(() => true))
            if (res) reset()
          },
          disable.isPending,
          'mfa-disable-confirm'
        )
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => reset('regenerate')} data-testid="mfa-regenerate">
            {t('重新生成恢复码')}
          </Button>
          {s.enforced ? (
            <span className="self-center text-xs text-muted-foreground">{t('管理员要求开启，不能关闭')}</span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => reset('disable')} data-testid="mfa-disable">
              {t('关闭')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
