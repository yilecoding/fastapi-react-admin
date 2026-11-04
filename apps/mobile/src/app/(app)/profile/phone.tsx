import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { isPhoneNumber, SMS_RESEND_SECONDS } from '@admin/api'

import { DangerRow, Group, GroupHeader, Row } from '@/components/grouped'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { api } from '@/lib/api'
import { parseFieldErrors } from '@/lib/field-errors'
import { useSession } from '@/lib/session'

/**
 * 绑定手机号（#224 第 1 条），照 web 个人中心的 `PhoneBlock` 做，后端接口全是现成的：
 *
 * - `POST /sys/users/me/phone/captcha` 给**要绑的那个号**发短信验证码
 * - `PUT  /sys/users/me/phone` 号码 + 验证码绑定，成功后 `phone_verified_time` 有值
 * - `DELETE /sys/users/me/phone` 解绑，号码和验证时间一起清
 *
 * 🔴 **当前号后面必须写明「已验证 / 未验证」。** 管理员在用户管理里录的号、批量导入的号
 * `phone_verified_time` 为空，手机验证码登录**不认**这种号。不写的话用户看到「有号」，
 * 去登录屏发码却登不进来，还看不出原因。未验证时提示用验证码重新绑一次（同一个号也行）。
 *
 * 发码失败一律显示出来（硬纪律 9）：没配短信通道、号码已被别人占用（409）、太频繁（429）
 * 都是在这一步报的 —— 吞掉的话用户会对着一个永远等不来短信的验证码框发呆。
 */
export default function PhoneScreen() {
  const { t } = useTranslation()
  const { user, reload } = useSession()

  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [unbinding, setUnbinding] = React.useState(false)
  const [confirmingUnbind, setConfirmingUnbind] = React.useState(false)
  const [sendError, setSendError] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  /**
   * 码发给了哪个号。服务端冷却按号码算：改了号，倒计时和「已发送」都不该再挂着（同登录屏）
   */
  const [sentTo, setSentTo] = React.useState('')
  /**
   * 倒计时按**截止时刻**算，不按「每秒减一」数：看短信要切到别的 App，回来时 JS 计时器
   * 可能被挂起过，数出来的秒数会比真实的长（同登录屏）
   */
  const [deadline, setDeadline] = React.useState(0)
  const [left, setLeft] = React.useState(0)

  /** 发码单飞（硬纪律 10）：接口按操作人 5 分钟 3 次，倒计时要等响应回来才开始，挡不住第二下 */
  const sendInFlight = React.useRef(false)
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  React.useEffect(() => {
    if (deadline === 0) return
    const tick = () => {
      const n = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setLeft(n)
      return n
    }
    tick()
    const timer = setInterval(() => {
      if (tick() === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [deadline])

  if (!user) return null

  const target = phone.trim()
  const phoneOk = isPhoneNumber(target)
  const malformed = target.length >= 11 && !phoneOk
  const forThisPhone = sentTo !== '' && sentTo === target
  const cooling = forThisPhone && left > 0
  const canSend = phoneOk && !sending && !cooling
  const canSave = phoneOk && code.trim().length > 0 && !saving
  const verified = Boolean(user.phone && user.phone_verified_time)

  async function sendCode() {
    if (sendInFlight.current || !canSend) return
    sendInFlight.current = true
    setSending(true)
    setSendError(null)
    setSaveError(null)
    try {
      await api.POST('/api/v1/sys/users/me/phone/captcha', { body: { phone: target } })
      if (!alive.current) return
      setSentTo(target)
      setDeadline(Date.now() + SMS_RESEND_SECONDS * 1000)
    } catch (err) {
      if (alive.current) setSendError(parseFieldErrors(err).general ?? t('验证码发送失败，请检查短信配置'))
    } finally {
      sendInFlight.current = false
      if (alive.current) setSending(false)
    }
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    setFieldErrors({})
    try {
      await api.PUT('/api/v1/sys/users/me/phone', { body: { phone: target, captcha: code.trim() } })
      // 先刷新会话再清表单：当前号和「已验证」要立刻换成新的，不能等下拉刷新
      await reload()
      if (!alive.current) return
      setPhone('')
      setCode('')
      setSentTo('')
      setDeadline(0)
      toast.success(t('手机号已更新'))
    } catch (err) {
      if (!alive.current) return
      const parsed = parseFieldErrors(err)
      setSaveError(parsed.general ?? t('手机号绑定失败'))
      setFieldErrors(parsed.fields)
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  async function unbind() {
    setConfirmingUnbind(false)
    setUnbinding(true)
    setSaveError(null)
    try {
      await api.DELETE('/api/v1/sys/users/me/phone')
      await reload()
      if (alive.current) toast.success(t('手机号已解绑'))
    } catch (err) {
      if (alive.current) setSaveError(parseFieldErrors(err).general ?? t('解绑失败'))
    } finally {
      if (alive.current) setUnbinding(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="bg-background flex-1">
      <ScrollView contentContainerClassName="pb-10" keyboardShouldPersistTaps="handled">
        <GroupHeader>{t('当前手机号')}</GroupHeader>
        <Group>
          {/* ⚠️ 号码不许收缩、整行允许折行：英文的「Entered by an administrator, not verified」
              很长，原来号码是 `flex-1`，被它挤成「1390013900 / 0」两行（实测，en-US） */}
          <Row first className="flex-wrap gap-y-2">
            <Text className="mr-auto shrink-0 font-mono text-[15px]" testID="phone-current">
              {user.phone || t('未绑定')}
            </Text>
            {user.phone ? (
              <Badge variant={verified ? 'secondary' : 'outline'} testID="phone-verified">
                <Text className={verified ? undefined : 'text-amber-700 dark:text-amber-300'}>
                  {verified ? t('已验证') : t('管理员录入，未验证')}
                </Text>
              </Badge>
            ) : null}
          </Row>
        </Group>
        {user.phone && !verified ? (
          <Text className="text-muted-foreground px-5 pt-2 text-xs leading-5">
            {t('未验证的号不能用来登录，用验证码重新绑一次即可（填同一个号也行）。')}
          </Text>
        ) : null}

        <GroupHeader>{user.phone ? t('换绑手机号') : t('绑定手机号')}</GroupHeader>
        <Group>
          <Row first>
            <Text className="min-w-[76px] shrink-0 text-[15px]">{t('新手机号')}</Text>
            <Input
              value={phone}
              onChangeText={(v) => {
                setPhone(v)
                setSendError(null)
                setSaveError(null)
              }}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              maxLength={11}
              placeholder="13800000000"
              testID="phone-input"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
            />
          </Row>
          {fieldErrors.phone ? (
            <Text className="text-destructive px-5 pb-2 text-xs leading-4">{fieldErrors.phone}</Text>
          ) : null}
          <Row>
            <Text className="min-w-[76px] shrink-0 text-[15px]">{t('短信验证码')}</Text>
            <Input
              value={code}
              onChangeText={(v) => {
                setCode(v)
                setSaveError(null)
              }}
              keyboardType="number-pad"
              // iOS 从短信里取码填进来；Android 走 autofill 的 sms-otp（同登录屏）
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              maxLength={6}
              placeholder="123456"
              onSubmitEditing={() => void save()}
              testID="phone-code"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!canSend}
              onPress={() => void sendCode()}
              testID="phone-send"
              // 定宽：「发送验证码」和「58 秒」来回切时输入框不跟着伸缩
              className="min-w-[96px]"
            >
              {sending ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text>{cooling ? t('{{n}} 秒', { n: left }) : t('发送验证码')}</Text>
              )}
            </Button>
          </Row>
          {fieldErrors.captcha ? (
            <Text className="text-destructive px-5 pb-2 text-xs leading-4">{fieldErrors.captcha}</Text>
          ) : null}
        </Group>

        {/* 脚注同一格：号码格式不对 > 发码失败 > 已发送（只对发过的那个号）*/}
        {malformed ? (
          <Text className="text-destructive px-5 pt-2 text-xs leading-5" testID="phone-malformed">
            {t('手机号格式不正确')}
          </Text>
        ) : sendError ? (
          <Text className="text-destructive px-5 pt-2 text-xs leading-5" testID="phone-send-error">
            {sendError}
          </Text>
        ) : forThisPhone ? (
          <Text className="text-muted-foreground px-5 pt-2 text-xs leading-5" testID="phone-sent">
            {t('验证码已发往该手机号，5 分钟内有效')}
          </Text>
        ) : null}

        {saveError ? (
          <Text className="text-destructive px-5 pt-2 text-sm" testID="phone-error">
            {saveError}
          </Text>
        ) : null}

        <View className="px-4 pt-4">
          <Button disabled={!canSave} onPress={() => void save()} testID="phone-submit" className="h-[50px] rounded-xl">
            {saving ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text className="text-base font-semibold">{saving ? t('提交中') : t('绑定手机号')}</Text>
          </Button>
        </View>

        {user.phone ? (
          <View className="pt-6">
            <Group>
              <DangerRow
                label={unbinding ? t('提交中') : t('解绑当前手机号')}
                onPress={() => {
                  if (!unbinding) setConfirmingUnbind(true)
                }}
                testID="phone-unbind"
              />
            </Group>
          </View>
        ) : null}
      </ScrollView>

      <ConfirmDialog
        open={confirmingUnbind}
        onOpenChange={setConfirmingUnbind}
        title={t('解绑当前手机号')}
        description={t('解绑后不能再用手机验证码登录，之后可以重新绑定。')}
        confirmLabel={t('解绑')}
        cancelLabel={t('取消')}
        variant="destructive"
        onConfirm={() => void unbind()}
        testID="phone-unbind-dialog"
      />
    </KeyboardAvoidingView>
  )
}
