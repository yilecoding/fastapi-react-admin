import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { IconAlertTriangle, IconCheck, IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Label } from '@admin/ui/components/label'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Switch } from '@admin/ui/components/switch'

import { ApiError } from '../../api-client/errors'
import { usePerm } from '../../auth/use-perm'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import {
  useResetUserPassword, useToggleUserPermission,
  type User, type UserPermissionType,
} from './api'

/**
 * 「权限与安全」抽屉 —— 两件**超管专属**的操作。
 *
 * 在这之前界面上没有任何入口：
 * - `PUT /users/{pk}/permissions` —— 停用账号、授予后台登录/超管、开关多端登录
 * - `PUT /users/{pk}/password` —— 用户忘了密码，管理员没法帮他重置
 *
 * 两个接口都挂 `DependsSuperUser`（不是权限码），所以入口按 `isSuperuser` 判，
 * 不用 `<Can perm>`。
 */

type Flag = {
  type: UserPermissionType
  label: string
  desc: string
  /** 从用户对象里读当前值 */
  read: (u: User) => boolean
  /** 打开会放宽安全边界的，勾之前要二次确认 */
  sensitive?: boolean
}

/**
 * ⚠️ 这张表是**模块级常量**，里面不能出现 `t(...)` —— 模块作用域没有 `t`，
 * hook 也不允许在那里调用（i18n codemod 曾把文案改成 `t()` 放在这里，
 * 结果整个应用启动即 `ReferenceError: t is not defined`）。
 * 所以这里只存 i18n key，渲染时在组件内部翻译。
 */
const FLAGS: Flag[] = [
  {
    type: 'status',
    label: '账号启用',
    desc: '关掉后该用户无法登录，已签发的 token 也会失效。',
    read: (u) => u.status === 1,
  },
  {
    type: 'staff',
    label: '后台登录',
    desc: '允许登录管理后台。关掉后账号仍在，但进不了这个系统。',
    read: (u) => u.is_staff,
  },
  {
    type: 'multi_login',
    label: '多端登录',
    desc: '允许同一账号在多处同时在线。关掉后新登录会踢掉旧会话。',
    read: (u) => u.is_multi_login,
  },
  {
    type: 'superuser',
    label: '超级管理员',
    desc: '拥有全部权限，绕过所有权限码与数据范围校验。',
    read: (u) => u.is_superuser,
    sensitive: true,
  },
]

export function UserSecuritySheet({
  open, onOpenChange, user,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  user: User | null
}) {
  const { t } = useTranslation()
  const { isSuperuser } = usePerm()
  const toggle = useToggleUserPermission()
  const reset = useResetUserPassword()

  const [busy, setBusy] = React.useState<UserPermissionType | null>(null)
  const [flagError, setFlagError] = React.useState<string | null>(null)
  const [pendingFlag, setPendingFlag] = React.useState<Flag | null>(null)

  const [pwd, setPwd] = React.useState('')
  const [pwd2, setPwd2] = React.useState('')
  const [pwdState, setPwdState] = React.useState<'idle' | 'ok' | 'error'>('idle')
  const [pwdMsg, setPwdMsg] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setFlagError(null)
    setPwd(''); setPwd2(''); setPwdState('idle'); setPwdMsg(null)
  }, [open, user?.id])

  if (!user) return null

  async function apply(flag: Flag) {
    if (!user) return
    setFlagError(null)
    setBusy(flag.type)
    try {
      await toggle.mutateAsync({ id: user.id, type: flag.type })
    } catch (e) {
      // 「禁止修改自身权限」这类服务端规则，原话显示出来比自己编好
      setFlagError(e instanceof ApiError ? e.message : t('权限切换失败'))
    } finally {
      setBusy(null)
    }
  }

  const mismatch = pwd2.length > 0 && pwd !== pwd2
  const pwdReady = pwd.length > 0 && pwd2.length > 0 && !mismatch

  async function submitPwd(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return
    setPwdState('idle'); setPwdMsg(null)
    try {
      await reset.mutateAsync({ id: user.id, password: pwd })
      setPwd(''); setPwd2('')
      setPwdState('ok')
    } catch (err) {
      // 口令策略在服务端（读 sys_config），客户端不复刻规则
      setPwdState('error')
      setPwdMsg(err instanceof ApiError ? err.message : t('重置失败'))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('权限与安全 · {{who}}', { who: user.nickname || user.username })}</SheetTitle>
          <SheetDescription>
            <Trans
              t={t}
              i18nKey="这两组操作都只有超级管理员能做，且<b>不能作用于自己</b>。"
              components={{ b: <strong /> }}
            />
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          {!isSuperuser && (
            <p className="text-sm text-muted-foreground" data-testid="sec-not-superuser">
              {t('你不是超级管理员，这里的操作都会被服务端拒绝。')}
            </p>
          )}

          {/* ── 权限开关 ── */}
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('权限')}</span>
            <div className="flex flex-col divide-y divide-border/60">
              {FLAGS.map((f) => {
                const on = f.read(user)
                return (
                  <div key={f.type} className="flex items-start justify-between gap-4 py-2.5">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm">{t(f.label)}</span>
                      <span className="text-xs text-muted-foreground">{t(f.desc)}</span>
                    </div>
                    <Switch
                      checked={on}
                      disabled={!isSuperuser || busy !== null}
                      data-testid={`sec-flag-${f.type}`}
                      aria-label={on ? t('停用 {{name}}', { name: t(f.label) }) : t('启用 {{name}}', { name: t(f.label) })}
                      onCheckedChange={() => {
                        // 开启超管是放宽安全边界，先拦一下
                        if (f.sensitive && !on) setPendingFlag(f)
                        else void apply(f)
                      }}
                    />
                  </div>
                )
              })}
            </div>
            {flagError && (
              <p className="flex items-center gap-1.5 pt-1 text-sm text-destructive" data-testid="sec-flag-error">
                <IconAlertTriangle className="size-3.5 shrink-0" />
                {flagError}
              </p>
            )}
          </div>

          {/* ── 重置密码 ── */}
          <form onSubmit={submitPwd} className="flex flex-col gap-3 border-t border-border/60 pt-4">
            <span className="text-sm font-medium">{t('重置密码')}</span>
            <p className="text-xs text-muted-foreground">
              {t('不需要原密码。强度规则由服务端「参数配置」里的口令策略决定，重置后该用户的登录态会失效。')}
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sec-pwd">{t('新密码')}</Label>
              <Input
                id="sec-pwd" data-testid="sec-pwd" type="password" value={pwd}
                autoComplete="new-password" disabled={!isSuperuser}
                onChange={(e) => { setPwd(e.target.value); setPwdState('idle') }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sec-pwd2">{t('确认新密码')}</Label>
              <Input
                id="sec-pwd2" data-testid="sec-pwd2" type="password" value={pwd2}
                autoComplete="new-password" disabled={!isSuperuser}
                onChange={(e) => { setPwd2(e.target.value); setPwdState('idle') }}
              />
              {mismatch && (
                <span className="text-xs text-destructive" data-testid="sec-pwd-mismatch">
                  {t('两次输入的密码不一致')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="submit" size="sm" data-testid="sec-pwd-submit"
                disabled={!isSuperuser || !pwdReady || reset.isPending}
              >
                {reset.isPending && <IconLoader2 className="size-4 animate-spin" />}
                {t('重置密码')}
              </Button>
              {pwdState === 'ok' && (
                <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400"
                      data-testid="sec-pwd-ok">
                  <IconCheck className="size-3.5" />
                  {t('已重置')}
                </span>
              )}
              {pwdState === 'error' && (
                <span className="flex items-center gap-1.5 text-sm text-destructive" data-testid="sec-pwd-error">
                  <IconAlertTriangle className="size-3.5 shrink-0" />
                  {pwdMsg}
                </span>
              )}
            </div>
          </form>
        </div>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" type="button" />}>{t('关闭')}</SheetClose>
        </SheetFooter>
      </SheetContent>

      <ConfirmDialog
        open={pendingFlag !== null}
        onOpenChange={(o) => !o && setPendingFlag(null)}
        title={t("授予超级管理员")}
        description={
          pendingFlag
            ? t('确定把「{{who}}」设为超级管理员吗？', { who: user.nickname || user.username }) +
              t('超管绕过所有权限码与数据范围校验，等于把整个平台交给这个账号。')
            : ''
        }
        confirmText={t("授予")}
        destructive
        pending={busy === 'superuser'}
        onConfirm={async () => {
          const f = pendingFlag
          setPendingFlag(null)
          if (f) await apply(f)
        }}
      />
    </Sheet>
  )
}
