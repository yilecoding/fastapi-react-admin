import { Stack } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { KeyRoundIcon, LogOutIcon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react-native'
import * as React from 'react'
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BrandTop } from '@/components/brand-top'
import { Group, Row } from '@/components/grouped'
import { PublicNotices } from '@/components/public-notices'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Text } from '@/components/ui/text'
import {
  ApiError,
  isPhoneNumber,
  normalizePhone,
  SESSION_END_MESSAGE,
  shouldReloadCaptcha,
  SMS_RESEND_SECONDS,
} from '@admin/api'

import { api } from '@/lib/api'
import { BRAND } from '@/lib/brand'
import { remembered } from '@/lib/remember'
import { useSession, type MfaChallenge } from '@/lib/session'

/**
 * 登录方式 —— 和 web 端登录页的两个页签一一对应（`_guest/sign-in.tsx` 的 `METHODS`）。
 * 扫码登录不做：它在 `apps/mobile` 分册开头那张「明确不做」的清单里（#193 把两端的占位页签一起删了）
 */
const METHODS = [
  { value: 'password', label: '密码', icon: KeyRoundIcon },
  { value: 'phone', label: '手机', icon: SmartphoneIcon },
] as const

type Method = (typeof METHODS)[number]['value']

/**
 * 验证码的状态机 —— 根 `CLAUDE.md` 硬纪律 9。web 登录页就是在这里踩过：
 * `catch {}` 里把验证码字段藏掉，限流 429 被吞 → 字段消失 → 后端仍强制校验
 * → 用户拿到一个怎么点都登不进去、还看不出原因的表单。
 *
 * `off` **只给「服务端明确说关了」这一种情况**，失败一律是 `error` + 重试入口。
 */
type CaptchaState =
  | { kind: 'loading' }
  | { kind: 'ready'; uuid: string; image: string }
  | { kind: 'off' }
  /**
   * ⚠️ **存的是「哪一类错」，不是翻好的字符串。**
   *
   * 翻译要在**渲染时**做。原来是在 `loadCaptcha` 里就 `t(...)` 存进 state，
   * 有两个毛病：一是那个 `t` 来自 `useCallback([], …)` 的闭包，切语言之后
   * 拿到的是**旧的**；二是就算修了闭包，已经存进 state 的那句话也不会
   * 跟着界面换语言。`rateLimited` 那种可预期的错走 key，
   * 其余带上服务端原文（`msg`，那本来就是后端按 `Accept-Language` 翻好的）。
   */
  | { kind: 'error'; rateLimited: boolean; msg: string }

export default function LoginScreen() {
  const { t } = useTranslation()
  const { login, loginByPhone, verifyMfa, bootstrapError, endReason } = useSession()
  const insets = useSafeAreaInsets()

  const [method, setMethod] = React.useState<Method>('password')
  /*
   * 🔴 **发布版不能预填账号。** 这里原来硬写 `'admin'` —— 开发期方便，
   * 但那个值会跟着进 APK：装到别人手机上，用户名框里躺着一个 `admin`。
   * `__DEV__` 是 RN 的编译期常量（release 构建里是 `false`，整块会被摇掉）。
   */
  const [username, setUsername] = React.useState(__DEV__ ? 'admin' : '')
  const [remember, setRemember] = React.useState(true)
  const [password, setPassword] = React.useState('')
  const [code, setCode] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  /**
   * 三个提交（密码 / 手机验证码 / 动态码）的单飞，用 ref 判、不等 `submitting` 那次重渲染（硬纪律 10）。
   * 后两个拿的都是一次性的码：同一个码打两次，第二次必然失败，还会被后端记一次账号 + IP 的失败计数
   */
  const submitInFlight = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  /**
   * 二次验证（#181）：第一步过了、还差动态码。`from` 记第一步走的是哪个页签 ——
   * 退回时只有密码那条要换图形验证码（它在第一步被消费了），见 `leaveMfa`
   */
  const [mfa, setMfa] = React.useState<{ challenge: MfaChallenge; from: Method } | null>(null)
  const [otp, setOtp] = React.useState('')

  /*
   * 手机验证码登录（#168，照 web 登录页的手机页签）。状态放在这一层而不是页签自己的组件里：
   * 切去密码页签、或者进了二次验证再回来，号码和倒计时都还在 —— 倒计时一丢，用户以为能再发，点了只拿到一句「太频繁」。
   *
   * 图形验证码和密码页签**共用同一张**（同 web）：发码时服务端校验并消费，发完要换一张。
   */
  const [phone, setPhone] = React.useState('')
  const [smsCode, setSmsCode] = React.useState('')
  const [smsSending, setSmsSending] = React.useState(false)
  const [smsSent, setSmsSent] = React.useState(false)
  /**
   * 码发给了哪个号。服务端的冷却是**按号码**算的：改了号，倒计时和「已发送」都不该再挂着 ——
   * 否则按钮对一个没发过的号锁 60 秒，提示还说「已发送」。改回原来那个号时两样都接着显示
   */
  const [smsPhone, setSmsPhone] = React.useState('')
  const [phoneError, setPhoneError] = React.useState<string | null>(null)
  /**
   * 倒计时按**截止时刻**算，不按「每秒减一」数：看短信要切到别的 App，回来时 JS 计时器可能被挂起过，
   * 数出来的秒数会比真实的长。显示值每秒按截止时刻重算一次
   */
  const [smsDeadline, setSmsDeadline] = React.useState(0)
  const [smsLeft, setSmsLeft] = React.useState(0)
  /**
   * 发码单飞（硬纪律 10）：接口 5 次 / 分钟，每次还消费一张图形验证码。倒计时要等响应回来才开始，
   * 挡不住第一次响应回来之前的第二下 —— 用 ref 判，不等 `smsSending` 那次重渲染
   */
  const smsInFlight = React.useRef(false)

  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * 验证码。
   *
   * 🔴 **硬纪律 10（有限流的接口必须做单飞）现在是 query 层给的。**
   * `/auth/captcha` 是 5 次/30 秒，而 StrictMode 开发期把 effect 跑两遍 ——
   * 手写版本要自己维护一个 `inFlight` ref 加一个 `alive` ref。
   * React Query 对同一个 key 的并发请求天然去重，那就是单飞；
   * 卸载后不 setState 也是它管的。
   *
   * ⚠️ `retry` 在 `lib/query.tsx` 里对 429 显式返回 false —— 限流重试就是
   * 拿配额换一次必然的失败。
   */
  const captchaQuery = useQuery({
    queryKey: ['auth', 'captcha'] as const,
    queryFn: () => api.GET('/api/v1/auth/captcha'),
    // 验证码是一次性的，不该被当成「新鲜数据」复用
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

  /**
   * 摊成一个状态机 —— 根 `CLAUDE.md` 硬纪律 9。web 登录页就是在这里踩过：
   * `catch {}` 里把验证码字段藏掉，限流 429 被吞 → 字段消失 → 后端仍强制校验
   * → 用户拿到一个怎么点都登不进去、还看不出原因的表单。
   *
   * `off` **只给「服务端明确说关了」这一种情况**，失败一律是 `error` + 重试入口。
   */
  const captcha: CaptchaState = React.useMemo(() => {
    if (captchaQuery.isPending) return { kind: 'loading' }
    if (captchaQuery.error) {
      const err = captchaQuery.error
      return {
        kind: 'error',
        rateLimited: err instanceof ApiError && err.isRateLimited,
        msg: err instanceof Error ? err.message : String(err),
      }
    }
    const d = captchaQuery.data
    if (!d?.is_enabled) return { kind: 'off' }
    return { kind: 'ready', uuid: d.uuid, image: d.image }
  }, [captchaQuery.isPending, captchaQuery.error, captchaQuery.data])

  /**
   * 换一张图形验证码。🔴 **旧答案在这里一起清掉**，不在各个调用点各配一句 —— 漏一处，旧答案就留在新图旁边：
   * 下一次登录报验证码错，手机页签上「发送验证码」照样可点、发出去被拒，白吃一次发码配额
   */
  const loadCaptcha = React.useCallback(() => {
    setCode('')
    void captchaQuery.refetch()
  }, [captchaQuery])

  React.useEffect(() => {
    if (smsDeadline === 0) return
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((smsDeadline - Date.now()) / 1000))
      setSmsLeft(left)
      if (left === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [smsDeadline])

  // 记住的账号回填。SecureStore 是异步读，所以先渲染上面那个初值，读到再覆盖
  React.useEffect(() => {
    void remembered.get().then((u) => {
      if (!alive.current) return
      if (u) setUsername(u)
      setRemember(u !== '')
    })
  }, [])

  async function submit() {
    if (submitInFlight.current) return
    submitInFlight.current = true
    setError(null)
    setSubmitting(true)
    try {
      const challenge = await login({
        username: username.trim(),
        password,
        uuid: captcha.kind === 'ready' ? captcha.uuid : undefined,
        captcha: captcha.kind === 'ready' ? code.trim() : undefined,
      })
      await remembered.set(remember ? username.trim() : null)
      if (challenge) {
        setOtp('')
        setMfa({ challenge, from: 'password' })
      }
      // 成功之后不用手动跳转：根布局按 session.status 决定渲染哪一棵树
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // 验证码是一次性的，失败后必须换一张，否则用户重试必然再错一次。
      // 🔴 例外是撞了限流（429）：验证码没被消费，跟着重拉只会把 `/auth/captcha` 的配额也打满（判据见 `@admin/api`）
      if (captcha.kind === 'ready' && shouldReloadCaptcha(err)) loadCaptcha()
    } finally {
      submitInFlight.current = false
      if (alive.current) setSubmitting(false)
    }
  }

  /**
   * 发短信验证码。🔴 没注册 / 没验证过的号也返回「成功」（后端防号码枚举，不真发），
   * 所以「已发送」的提示要带上「没收到就去核对号码」—— 照 web 的措辞
   */
  async function sendSms() {
    if (smsInFlight.current) return
    smsInFlight.current = true
    setSmsSending(true)
    setPhoneError(null)
    setSmsSent(false)
    let reloadCaptcha = true
    const target = phone.trim()
    try {
      await api.POST('/api/v1/auth/phone/captcha', {
        body: {
          phone: target,
          uuid: captcha.kind === 'ready' ? captcha.uuid : null,
          captcha: captcha.kind === 'ready' ? code.trim() : null,
        },
      })
      if (!alive.current) return
      setSmsSent(true)
      setSmsPhone(target)
      setSmsDeadline(Date.now() + SMS_RESEND_SECONDS * 1000)
      setSmsLeft(SMS_RESEND_SECONDS)
    } catch (err) {
      reloadCaptcha = shouldReloadCaptcha(err)
      if (alive.current) setPhoneError(err instanceof Error ? err.message : String(err))
    } finally {
      smsInFlight.current = false
      if (alive.current) {
        setSmsSending(false)
        // 图形验证码发码时已被服务端校验（对了就消费，错了也换一张）；只有限流那次没被碰过
        if (captcha.kind === 'ready' && reloadCaptcha) loadCaptcha()
      }
    }
  }

  async function submitPhone() {
    // 键盘上的「完成」不看按钮禁没禁用，条件要在这里再判一次
    if (submitInFlight.current || !isPhoneNumber(phone) || smsCode.trim().length === 0) return
    submitInFlight.current = true
    setPhoneError(null)
    setSubmitting(true)
    try {
      const challenge = await loginByPhone({ phone: phone.trim(), captcha: smsCode.trim() })
      if (challenge) {
        setOtp('')
        setError(null)
        setMfa({ challenge, from: 'phone' })
      }
      // 成功之后不用手动跳转：根布局按 session.status 决定渲染哪一棵树
    } catch (err) {
      // 没注册 / 没验证 / 码错 / 码过期一律同一句（后端防枚举），原样显示即可
      setPhoneError(err instanceof Error ? err.message : String(err))
    } finally {
      submitInFlight.current = false
      if (alive.current) setSubmitting(false)
    }
  }

  async function submitOtp() {
    if (submitInFlight.current || !mfa) return
    submitInFlight.current = true
    setError(null)
    setSubmitting(true)
    try {
      await verifyMfa(mfa.challenge.token, otp.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOtp('')
    } finally {
      submitInFlight.current = false
      if (alive.current) setSubmitting(false)
    }
  }

  /**
   * 从二次验证退回第一步（回到原来那个页签）。短信验证码第一步对了就被消费掉了，留在框里只会再错一次。
   * 图形验证码只在第一步是**密码**时换：手机那条在发码之后已经换过一张、还没用过，再拉只是多吃
   * `/auth/captcha` 的配额（5 次 / 30 秒），反复进出二次验证很快就撞上
   */
  function leaveMfa() {
    const from = mfa?.from
    setMfa(null)
    setOtp('')
    setError(null)
    setSmsCode('')
    if (from === 'password' && captcha.kind === 'ready') loadCaptcha()
  }

  const canSubmit =
    username.trim().length > 0 &&
    password.length > 0 &&
    (captcha.kind !== 'ready' || code.trim().length > 0) &&
    !submitting

  const phoneOk = isPhoneNumber(phone)
  // 输入已经规整成纯数字（`normalizePhone`），够 11 位还不对就是格式错 —— 要说出来，不能只把按钮灰着
  const phoneMalformed = phone.length >= 11 && !phoneOk
  // 倒计时和「已发送」只对发过码的那个号成立（见 `smsPhone`）
  const smsForPhone = smsPhone !== '' && smsPhone === phone.trim()
  const smsCooling = smsForPhone && smsLeft > 0
  // 图形验证码开着时必须先填：不填后端照样拒，还白吃一次发码配额
  const canSendSms =
    phoneOk &&
    !smsSending &&
    !smsCooling &&
    captcha.kind !== 'loading' &&
    captcha.kind !== 'error' &&
    (captcha.kind !== 'ready' || code.trim().length > 0)
  const canSubmitPhone = phoneOk && smsCode.trim().length > 0 && !submitting

  /*
   * 启动时连不上 / 为什么回到了登录屏（#138）—— 两个页签**都要**显示：
   * 只挂在密码页签上的话，切到手机页签的人什么说明都看不到。
   * 疑似凭据被盗 / 账号被停用用醒目的样式，其余是提示
   */
  const sessionNotice = bootstrapError ? (
    <View className="px-4">
      <Alert variant="destructive" icon={KeyRoundIcon}>
        <AlertTitle>{t('启动时没能连上服务器')}</AlertTitle>
        <AlertDescription>{bootstrapError}</AlertDescription>
      </Alert>
    </View>
  ) : endReason ? (
    <View className="px-4">
      <Alert
        variant={endReason === 'reuse' || endReason === 'disabled' ? 'destructive' : 'default'}
        icon={LogOutIcon}
        testID="session-end-notice"
      >
        <AlertDescription>{t(SESSION_END_MESSAGE[endReason])}</AlertDescription>
      </Alert>
    </View>
  ) : null

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        // Android 上键盘遮挡输入框是最常见的移动端落差之一（issue #39 第 2.5 节）
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="bg-background flex-1"
      >
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          contentContainerClassName="min-h-full"
          keyboardShouldPersistTaps="handled"
        >
          {/* 品牌头：唯一的品牌表达，不铺满不饱和 */}
          <BrandTop>
            <View className="gap-1.5">
              <Text className="text-primary font-mono text-[10px]" style={{ letterSpacing: 2.4 }}>
                {t('权限与数据的承重层')}
              </Text>
              {/* iOS 大标题：34/700/-0.03em。这是这套语言里最重的一处排版 */}
              <Text className="text-3xl font-bold" style={{ letterSpacing: -0.9 }}>
                {t('登录')}
              </Text>
            </View>
          </BrandTop>

          <View className="px-4 pt-4">
            <Tabs value={method} onValueChange={(v) => setMethod(v as Method)}>
              <TabsList className="w-full flex-row">
                {METHODS.map((m) => (
                  <TabsTrigger key={m.value} value={m.value} className="flex-1 flex-row gap-1.5">
                    <Icon as={m.icon} className="size-3.5" />
                    <Text>{t(m.label)}</Text>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </View>

          {/* 🔴 两个页签内容高度要一致，否则切换时下面的东西会跳 */}
          <View style={{ minHeight: 336 }} className="pt-4">
            {mfa ? (
              <MfaStep
                challenge={mfa.challenge}
                otp={otp}
                onChangeOtp={setOtp}
                onSubmit={() => void submitOtp()}
                onBack={leaveMfa}
                submitting={submitting}
                error={error}
              />
            ) : method === 'phone' ? (
              <View className="gap-4">
                {sessionNotice}

                <Group>
                  <FieldRow first label={t('手机号')}>
                    <Input
                      value={phone}
                      // 🔴 先规整、不设 maxLength：自动填充的「+86 138 0013 8000」会被 maxLength 截断（见 `normalizePhone`）
                      onChangeText={(v) => setPhone(normalizePhone(v))}
                      keyboardType="number-pad"
                      textContentType="telephoneNumber"
                      autoComplete="tel"
                      placeholder={t('请输入手机号')}
                      testID="login-phone"
                      className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
                    />
                  </FieldRow>
                  <CaptchaRow state={captcha} code={code} onChangeCode={setCode} onRetry={loadCaptcha} />
                  <FieldRow label={t('短信验证码')}>
                    <Input
                      value={smsCode}
                      onChangeText={setSmsCode}
                      keyboardType="number-pad"
                      // iOS 从短信里取码填进来；Android 走 autofill 的 sms-otp
                      textContentType="oneTimeCode"
                      autoComplete="sms-otp"
                      maxLength={6}
                      placeholder="123456"
                      onSubmitEditing={() => void submitPhone()}
                      testID="login-sms-code"
                      className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canSendSms}
                      onPress={() => void sendSms()}
                      testID="login-sms-send"
                      // 定宽：「发送验证码」和「58 秒」来回切时输入框不跟着伸缩
                      className="min-w-[96px]"
                    >
                      {smsSending ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <Text>{smsCooling ? t('{{n}} 秒', { n: smsLeft }) : t('发送验证码')}</Text>
                      )}
                    </Button>
                  </FieldRow>
                </Group>

                {/* 分组块的脚注，同一格、高度不跳：号码格式不对 > 已发送（只对发过的那个号）> 哪种号能用 */}
                {phoneMalformed ? (
                  <Text variant="small" className="text-destructive px-5 leading-5" testID="login-phone-malformed">
                    {t('手机号格式不正确')}
                  </Text>
                ) : (
                  <Text
                    variant="small"
                    className="text-muted-foreground px-5 leading-5"
                    testID={smsSent && smsForPhone && !phoneError ? 'login-sms-sent' : undefined}
                  >
                    {smsSent && smsForPhone && !phoneError
                      ? t('验证码已发送，5 分钟内有效。没收到？核对号码是否在网页端个人中心验证过。')
                      : t('只认在网页端个人中心验证过的手机号')}
                  </Text>
                )}

                {phoneError ? (
                  <Text variant="small" className="text-destructive px-5" testID="login-phone-error">
                    {phoneError}
                  </Text>
                ) : null}

                <View className="px-4">
                  <Button
                    disabled={!canSubmitPhone}
                    onPress={() => void submitPhone()}
                    testID="login-phone-submit"
                    className="h-[50px] rounded-xl"
                  >
                    {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
                    <Text className="text-base font-semibold">{submitting ? t('登录中') : t('登录')}</Text>
                  </Button>
                </View>
              </View>
            ) : (
              <View className="gap-4">
                {sessionNotice}

                {/* 输入框做成**分组块里的行**：左侧标签、右侧输入。
                    iOS 上表单就是这个形状，不是一个个描边盒子 */}
                <Group>
                  <FieldRow first label={t('用户名')}>
                    <Input
                      value={username}
                      onChangeText={setUsername}
                      autoCapitalize="none"
                      autoCorrect={false}
                      textContentType="username"
                      placeholder="admin"
                      testID="login-username"
                      className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
                    />
                  </FieldRow>
                  <FieldRow label={t('密码')}>
                    <Input
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      textContentType="password"
                      placeholder="••••••"
                      onSubmitEditing={() => void submit()}
                      testID="login-password"
                      className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
                    />
                  </FieldRow>
                  <CaptchaRow
                    state={captcha}
                    code={code}
                    onChangeCode={setCode}
                    onRetry={loadCaptcha}
                    onSubmit={() => void submit()}
                  />
                </Group>

                {error ? (
                  <Text variant="small" className="text-destructive px-5" testID="login-error">
                    {error}
                  </Text>
                ) : null}

                <View className="gap-3 px-4">
                  {/* iOS 主按钮：满宽、50 高、大圆角 */}
                  <Button
                    disabled={!canSubmit}
                    onPress={() => void submit()}
                    testID="login-submit"
                    className="h-[50px] rounded-xl"
                  >
                    {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
                    <Text className="text-base font-semibold">{submitting ? t('登录中') : t('登录')}</Text>
                  </Button>

                  <Pressable
                    onPress={() => setRemember(!remember)}
                    hitSlop={8}
                    testID="login-remember"
                    className="flex-row items-center gap-2.5 self-start px-1 py-1"
                  >
                    {/* 可点区域包住文字 —— 方块本身在触屏上远低于可用尺寸 */}
                    <Checkbox checked={remember} onCheckedChange={setRemember} />
                    <Text variant="small" className="text-muted-foreground">
                      {t('记住账号')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>

          {/*
            登录页公告（#190，不用登录）。放在表单**下面**：它的加载 / 失败都不能挡住登录，
            放上面的话一来一回会把输入框顶下去，键盘弹起时还会把表单挤出可视区
          */}
          <PublicNotices />

          <View className="mt-auto flex-row items-center justify-between gap-3 px-5 pt-6">
            <Text numberOfLines={1} className="text-muted-foreground shrink font-mono text-[9.5px]">
              {BRAND.stack.join(' · ')}
            </Text>
            <Text className="text-muted-foreground font-mono text-[9.5px]">{BRAND.version}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

/** 表单的一行：左标签右输入。标签宽度固定，三行的输入起点才对得齐 */
function FieldRow({
  first,
  label,
  children,
}: {
  first?: boolean
  label: string
  children: React.ReactNode
}) {
  return (
    <Row first={first} inset={20}>
      {/*
        🔴 **标签列用 `min-w-*`，不能用 `w-*`。**
        写死 `w-[62px]` 在中文下正好（「用户名」3 个字约 45px，撑到 62 还整齐对齐），
        **英文下必然换行** —— 实测截图里是 `Usernam` / `e` 和 `Passwor` / `d`
        断成两行。中文开发看不到这个：只有把设备语言切成英文才现形。
        `min-w-*` 两头都对：中文仍然都是 62px（对齐不变），英文按自身宽度撑开、不换行。
      */}
      <Text className="min-w-[62px] shrink-0 text-[15px]">{label}</Text>
      {children}
    </Row>
  )
}

function CaptchaRow({
  state,
  code,
  onChangeCode,
  onRetry,
  onSubmit,
}: {
  state: CaptchaState
  code: string
  onChangeCode: (v: string) => void
  onRetry: () => void
  /** 键盘上的「完成」。手机页签不传：图形码填完下一步是点「发送验证码」，不是提交登录 */
  onSubmit?: () => void
}) {
  const { t } = useTranslation()
  if (state.kind === 'off') return null

  if (state.kind === 'loading') {
    return (
      <Row inset={20}>
        <Text className="min-w-[62px] shrink-0 text-[15px]">{t('验证码')}</Text>
        <ActivityIndicator size="small" />
        <Text variant="small" className="text-muted-foreground">
          {t('正在获取')}
        </Text>
      </Row>
    )
  }

  if (state.kind === 'error') {
    return (
      <Row inset={20} className="items-start">
        <Text className="min-w-[62px] shrink-0 text-[15px]">{t('验证码')}</Text>
        <View className="flex-1 gap-2 py-1">
          <Text variant="small" className="text-destructive">
            {state.rateLimited ? t('验证码请求太频繁，稍等一下再试') : state.msg}
          </Text>
          <Button variant="outline" size="sm" onPress={onRetry} className="self-start">
            <Text>{t('重试')}</Text>
          </Button>
        </View>
      </Row>
    )
  }

  return (
    <Row inset={20}>
      <Text className="min-w-[62px] shrink-0 text-[15px]">{t('验证码')}</Text>
      <Input
        value={code}
        onChangeText={onChangeCode}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={onSubmit}
        testID="login-captcha"
        className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
      />
      {/* 后端给的是**裸 base64**，不带 `data:` 前缀 —— 要自己拼，
          少拼的话 Image 静默什么都不显示（不报错） */}
      <Pressable onPress={onRetry} testID="login-captcha-image">
        <Image
          source={{ uri: `data:image/jpeg;base64,${state.image}` }}
          style={{ width: 92, height: 34, borderRadius: 5 }}
          resizeMode="contain"
        />
      </Pressable>
    </Row>
  )
}

/**
 * 二次验证的第二步（#181）。移动端只做「输动态码」：被强制、还没绑定的账号要扫码绑定，
 * 在手机上扫自己屏幕上的二维码做不到 —— 引导去网页端绑一次
 */
function MfaStep({
  challenge,
  otp,
  onChangeOtp,
  onSubmit,
  onBack,
  submitting,
  error,
}: {
  challenge: MfaChallenge
  otp: string
  onChangeOtp: (v: string) => void
  onSubmit: () => void
  onBack: () => void
  submitting: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  if (challenge.setup) {
    return (
      <View className="gap-4 px-4" testID="login-mfa-setup">
        <Alert icon={ShieldCheckIcon}>
          <AlertTitle>{t('要先开启二次验证')}</AlertTitle>
          <AlertDescription>
            {t('管理员要求这个账号开启二次验证。请先在电脑上用网页登录一次，按提示用认证器扫码绑定；之后在这里输入认证器上的动态码即可登录。')}
          </AlertDescription>
        </Alert>
        <Button variant="outline" onPress={onBack} className="h-[50px] rounded-xl">
          <Text>{t('返回')}</Text>
        </Button>
      </View>
    )
  }
  return (
    <View className="gap-4" testID="login-mfa">
      <Text variant="small" className="text-muted-foreground px-5">
        {t('这个账号开启了二次验证。输入认证器上的 6 位动态码；手机不在身边时可以用一个恢复码。')}
      </Text>
      <Group>
        <FieldRow first label={t('动态码')}>
          <Input
            value={otp}
            onChangeText={onChangeOtp}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={16}
            onSubmitEditing={onSubmit}
            testID="login-otp"
            className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
          />
        </FieldRow>
      </Group>
      {error ? (
        <Text variant="small" className="text-destructive px-5" testID="login-error">
          {error}
        </Text>
      ) : null}
      <View className="gap-3 px-4">
        <Button
          disabled={otp.trim().length < 6 || submitting}
          onPress={onSubmit}
          testID="login-otp-submit"
          className="h-[50px] rounded-xl"
        >
          {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Text className="text-base font-semibold">{t('验证')}</Text>
        </Button>
        <Pressable onPress={onBack} hitSlop={8} className="self-start px-1 py-1">
          <Text variant="small" className="text-muted-foreground">
            {t('返回重新登录')}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
