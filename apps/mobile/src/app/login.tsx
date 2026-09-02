import { Stack } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { KeyRoundIcon, QrCodeIcon, SmartphoneIcon } from 'lucide-react-native'
import * as React from 'react'
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCSSVariable } from 'uniwind'

import { BrandTop } from '@/components/brand-top'
import { Group, Row } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Text } from '@/components/ui/text'
import { ApiError } from '@admin/api-contract'

import { api } from '@/lib/api'
import { BRAND } from '@/lib/brand'
import type { Captcha } from '@/lib/contract'
import { remembered } from '@/lib/remember'
import { useSession } from '@/lib/session'

/**
 * 登录方式 —— 和 web 端登录页的三个页签一一对应（`_guest/sign-in.tsx` 的 `METHODS`）。
 * 后两个是**占位**：后端目前只开了账号密码这一条路径。
 *
 * 🔴 占位屏必须说清楚**为什么不能用**，并把人送回能用的那条 —— 光禁用一个页签
 * 只会让人反复去点它（web 那边的 `NotWired` 就是这么做的，措辞照抄）。
 */
const METHODS = [
  { value: 'password', label: '密码', icon: KeyRoundIcon },
  { value: 'phone', label: '手机', icon: SmartphoneIcon },
  { value: 'qrcode', label: '扫码', icon: QrCodeIcon },
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
  | { kind: 'error'; msg: string }

export default function LoginScreen() {
  const { t } = useTranslation()
  const { login, bootstrapError } = useSession()
  const insets = useSafeAreaInsets()
  const fgVar = useCSSVariable('--color-foreground')
  const fg = typeof fgVar === 'string' ? fgVar : '#111'

  const [method, setMethod] = React.useState<Method>('password')
  const [username, setUsername] = React.useState('admin')
  const [remember, setRemember] = React.useState(true)
  const [password, setPassword] = React.useState('')
  const [code, setCode] = React.useState('')
  const [captcha, setCaptcha] = React.useState<CaptchaState>({ kind: 'loading' })
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // 硬纪律 10：`/auth/captcha` 是 5 次/30 秒的限流接口，而 StrictMode 开发期
  // 把 effect 跑两遍 —— 不去重就是配额腰斩。`alive` 防卸载后 setState。
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
    setCaptcha({ kind: 'loading' })
    try {
      const data = await api.GET<Captcha>('/api/v1/auth/captcha')
      if (!alive.current) return
      setCaptcha(data.is_enabled ? { kind: 'ready', uuid: data.uuid, image: data.image } : { kind: 'off' })
    } catch (err) {
      if (!alive.current) return
      const msg =
        err instanceof ApiError && err.isRateLimited
          ? t('验证码请求太频繁，稍等一下再试')
          : err instanceof Error
            ? err.message
            : String(err)
      setCaptcha({ kind: 'error', msg })
    } finally {
      inFlight.current = false
    }
  }, [])

  React.useEffect(() => {
    void loadCaptcha()
  }, [loadCaptcha])

  // 记住的账号回填。异步读，所以初值先给 'admin'（开发期方便），读到再覆盖
  React.useEffect(() => {
    void remembered.get().then((u) => {
      if (!alive.current) return
      if (u) setUsername(u)
      setRemember(u !== '')
    })
  }, [])

  async function submit() {
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      await login({
        username: username.trim(),
        password,
        uuid: captcha.kind === 'ready' ? captcha.uuid : undefined,
        captcha: captcha.kind === 'ready' ? code.trim() : undefined,
      })
      await remembered.set(remember ? username.trim() : null)
      // 成功之后不用手动跳转：根布局按 session.status 决定渲染哪一棵树
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // 验证码是一次性的，失败后必须换一张，否则用户重试必然再错一次
      if (captcha.kind === 'ready') {
        setCode('')
        void loadCaptcha()
      }
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }

  const canSubmit =
    username.trim().length > 0 &&
    password.length > 0 &&
    (captcha.kind !== 'ready' || code.trim().length > 0) &&
    !submitting

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

          {/* 🔴 三个页签内容高度要一致，否则切换时下面的东西会跳 */}
          <View style={{ minHeight: 336 }} className="pt-4">
            {method !== 'password' ? (
              <NotWired method={method} onUsePassword={() => setMethod('password')} />
            ) : (
              <View className="gap-4">
                {bootstrapError ? (
                  <View className="px-4">
                    <Alert variant="destructive" icon={KeyRoundIcon}>
                      <AlertTitle>{t('启动时没能连上服务器')}</AlertTitle>
                      <AlertDescription>{bootstrapError}</AlertDescription>
                    </Alert>
                  </View>
                ) : null}

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
                    onRetry={() => void loadCaptcha()}
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
  const { t } = useTranslation()
  return (
    <Row first={first} inset={20}>
      <Text className="w-[62px] shrink-0 text-[15px]">{label}</Text>
      {children}
    </Row>
  )
}

/**
 * 还没接入的登录方式：说清楚为什么不能用，并把人送回能用的那条。
 * 措辞和 web 端 `_guest/sign-in.tsx` 的 `NotWired` 保持一致。
 */
function NotWired({ method, onUsePassword }: { method: Method; onUsePassword: () => void }) {
  const { t } = useTranslation()
  const copy =
    method === 'phone'
      ? {
          icon: SmartphoneIcon,
          title: '手机验证码登录还没接入',
          hint: '后端目前只开了账号密码这一条登录路径，手机号验证码要等短信通道接进来。',
        }
      : {
          icon: QrCodeIcon,
          title: '扫码登录还没接入',
          // web 那边的原话是「扫码需要一个能派发登录票据的移动端，现在还没有」——
          // 移动端就是眼前这个 App，所以这里换成缺的另一半：后端的票据接口
          hint: '扫码要后端有一套派发登录票据的接口，现在还没有。这个 App 将来就是扫码的那一端。',
        }
  return (
    <Group className="items-center gap-3 px-6 py-9">
      <Icon as={copy.icon} className="text-muted-foreground size-8" />
      <Text className="text-center font-medium">{t(copy.title)}</Text>
      <Text variant="small" className="text-muted-foreground text-center leading-5">
        {t(copy.hint)}
      </Text>
      <Button variant="outline" size="sm" onPress={onUsePassword} className="mt-1">
        <Text>{t('用密码登录')}</Text>
      </Button>
    </Group>
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
  onSubmit: () => void
}) {
  const { t } = useTranslation()
  if (state.kind === 'off') return null

  if (state.kind === 'loading') {
    return (
      <Row inset={20}>
        <Text className="w-[62px] shrink-0 text-[15px]">{t('验证码')}</Text>
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
        <Text className="w-[62px] shrink-0 text-[15px]">{t('验证码')}</Text>
        <View className="flex-1 gap-2 py-1">
          <Text variant="small" className="text-destructive">
            {state.msg}
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
      <Text className="w-[62px] shrink-0 text-[15px]">{t('验证码')}</Text>
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
