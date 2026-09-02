import { Stack } from 'expo-router'
import * as React from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCSSVariable } from 'uniwind'

import { KeyRoundIcon, QrCodeIcon, SmartphoneIcon } from 'lucide-react-native'

import { BrandBackdrop } from '@/components/brand-backdrop'
import { TenonMark } from '@/components/tenon-mark'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Icon } from '@/components/ui/icon'
import { Eyebrow, Rule } from '@/components/ui/panel'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { ApiError, api } from '@/lib/api'
import { BRAND } from '@/lib/brand'
import type { Captcha } from '@/lib/contract'
import { remembered } from '@/lib/remember'
import { useSession } from '@/lib/session'

/**
 * 登录页。
 *
 * 结构照搬 web 端登录页左栏那块 `.tenon-panel`（`-sign-in-brand.tsx`）：
 * **整屏是面板**（比页面低一档、带 277 色偏、方格底纹 + 左上辉光），
 * 表单是浮在面板上的一块 `node` 色的牌子。
 *
 * 🔴 **主色只出现在眉标和榫卯标记上，不铺色块。** 之前那版做的是一整条
 * 饱和紫的头部 —— 那是最通用的那个答案，和 web 端的克制完全对不上。
 */
/**
 * 登录方式 —— 和 web 端登录页的三个页签一一对应（`_guest/sign-in.tsx` 的 `METHODS`）。
 * 后两个是**占位**：后端目前只开了账号密码这一条路径。
 *
 * 🔴 占位屏必须说清楚**为什么不能用**，并把人送回能用的那条 —— 光禁用一个页签
 * 只会让人反复去点它（web 那边的 `NotWired` 就是这么做的，这里照抄那套措辞）。
 */
const METHODS = [
  { value: 'password', label: '密码登录', icon: KeyRoundIcon },
  { value: 'phone', label: '手机登录', icon: SmartphoneIcon },
  { value: 'qrcode', label: '扫码登录', icon: QrCodeIcon },
] as const

type Method = (typeof METHODS)[number]['value']

type CaptchaState =
  | { kind: 'loading' }
  | { kind: 'ready'; uuid: string; image: string }
  | { kind: 'off' }
  | { kind: 'error'; msg: string }

export default function LoginScreen() {
  const { login, bootstrapError } = useSession()
  const insets = useSafeAreaInsets()
  // 榫卯标记用正文墨色，不用主色 —— 主色留给眉标那一行，全屏只此一处彩色
  const inkVar = useCSSVariable('--color-ink')
  const ink = typeof inkVar === 'string' ? inkVar : '#111'

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
          ? '验证码请求太频繁，稍等一下再试'
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
      <View className="bg-panel flex-1">
        <BrandBackdrop className="absolute inset-0" />

        <KeyboardAvoidingView
          // Android 上键盘遮挡输入框是最常见的移动端落差之一（issue #39 第 2.5 节）。
          // 两个平台的行为不同，behavior 要分开给。
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="flex-1"
        >
          <ScrollView
            contentContainerStyle={{ paddingTop: insets.top + 28, paddingBottom: insets.bottom + 24 }}
            contentContainerClassName="min-h-full px-5"
            keyboardShouldPersistTaps="handled"
          >
            {/* 标识条 —— 对应 web 的 SignInBrandStrip：等宽 wordmark + 榫卯 */}
            <FadeIn delay={0}>
              <View className="flex-row items-center gap-2.5 pb-5">
                <TenonMark size={20} color={ink} />
                <Text className="text-ink font-mono text-xs" style={{ letterSpacing: 0.6 }}>
                  {BRAND.wordmark}
                </Text>
              </View>
              <Rule />
            </FadeIn>

            {/*
             * 🔴 文案和表单是**一组**，一起在剩余空间里居中。
             * 上一版把 `flex-1 justify-center` 只套在文案上、表单跟在后面 ——
             * 结果文案在剩余空间里居中、表单被挤到屏底，两段各自漂着，
             * 整屏看着就是「哪儿都不居中」。这是这一版唯一的结构改动。
             */}
            <View className="flex-1 justify-center gap-7 py-8">
              <View>
                <FadeIn delay={60}>
                  <Eyebrow>权限与数据的承重层</Eyebrow>
                </FadeIn>
                <FadeIn delay={110}>
                  {/* 显示级：字号大、字距收紧、行高压低 —— web 那边是
                      tracking-[-0.03em] / leading-[1.16]，这里按 30px 折算 */}
                  <Text
                    className="text-ink mt-3.5 text-[30px] font-semibold"
                    style={{ letterSpacing: -0.9, lineHeight: 38 }}
                  >
                    一个入口{'\n'}管好权限与数据
                  </Text>
                </FadeIn>
                <FadeIn delay={160}>
                  <Text className="text-dim mt-2.5 text-sm leading-6">
                    组织、角色和数据范围各自成件，靠结构咬合。
                  </Text>
                </FadeIn>
              </View>

              {/* 表单牌子：浮在面板上的一块 node 色 */}
              <FadeIn delay={210}>
                <View className="bg-node border-hair overflow-hidden rounded-2xl border">
                  <MethodTabs value={method} onChange={setMethod} />
                  {/* 🔴 三个页签内容高度必须一致，否则切换时整块卡片会跳。
                      minHeight 取「密码表单」那一屏的高度 */}
                  <View style={{ minHeight: 268 }}>
                    {method !== 'password' ? (
                      <NotWired method={method} onUsePassword={() => setMethod('password')} />
                    ) : (
                      <View className="gap-3.5 p-5">
                        {bootstrapError ? (
                          <View className="border-destructive/40 bg-destructive/10 gap-1 rounded-xl border p-3">
                            <Text className="text-ink text-sm font-medium">启动时没能连上服务器</Text>
                            <Text className="text-dim text-xs">{bootstrapError}</Text>
                          </View>
                        ) : null}

                        <Input
                          value={username}
                          onChangeText={setUsername}
                          autoCapitalize="none"
                          autoCorrect={false}
                          textContentType="username"
                          placeholder="用户名"
                          testID="login-username"
                        />
                        <Input
                          value={password}
                          onChangeText={setPassword}
                          secureTextEntry
                          textContentType="password"
                          placeholder="密码"
                          onSubmitEditing={() => void submit()}
                          testID="login-password"
                        />
                        <CaptchaBlock
                          state={captcha}
                          code={code}
                          onChangeCode={setCode}
                          onRetry={() => void loadCaptcha()}
                          onSubmit={() => void submit()}
                        />

                        {error ? (
                          <Text className="text-destructive text-sm" testID="login-error">
                            {error}
                          </Text>
                        ) : null}

                        <Button
                          size="lg"
                          disabled={!canSubmit}
                          onPress={() => void submit()}
                          testID="login-submit"
                        >
                          {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
                          <Text>{submitting ? '登录中' : '登录'}</Text>
                        </Button>

                        <Checkbox
                          checked={remember}
                          onChange={setRemember}
                          label="记住账号"
                          testID="login-remember"
                        />
                      </View>
                    )}
                  </View>
                </View>
              </FadeIn>
            </View>

            {/* 页脚：技术栈 + 版本，等宽小字大字距 —— web 面板底部同款 */}
            <FadeIn delay={300}>
              <View className="gap-3">
                <Rule />
                <View className="flex-row items-center justify-between gap-3">
                  <Text
                    numberOfLines={1}
                    className="text-faint shrink font-mono text-[10px]"
                    style={{ letterSpacing: 2 }}
                  >
                    {BRAND.stack.join('  ·  ')}
                  </Text>
                  <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 2 }}>
                    {BRAND.version}
                  </Text>
                </View>
              </View>
            </FadeIn>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </>
  )
}

/**
 * 入场：上移 10px 的淡入，620ms，错开 60/110/160/210/300ms。
 * 曲线和延迟都照抄 web 的 `.tenon-in` —— 两端打开的节奏是一样的。
 *
 * ⚠️ 用 `Animated`（RN 自带）而不是 reanimated：这就一个透明度 + 位移，
 * 不值得为它引入 worklet 那一层。
 */
function FadeIn({ delay = 0, children }: { delay?: number; children: React.ReactNode }) {
  const t = React.useRef(new Animated.Value(0)).current
  React.useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 620, delay, useNativeDriver: true }).start()
  }, [t, delay])
  return (
    <Animated.View
      style={{ opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}
    >
      {children}
    </Animated.View>
  )
}

function CaptchaBlock({
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
  if (state.kind === 'off') return null

  if (state.kind === 'loading') {
    return (
      <View className="h-12 flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text className="text-dim text-sm">正在取验证码</Text>
      </View>
    )
  }

  if (state.kind === 'error') {
    return (
      <View className="border-destructive/40 bg-destructive/10 gap-2 rounded-xl border p-3">
        <Text className="text-ink text-sm">验证码没取到：{state.msg}</Text>
        <Button size="sm" variant="outline" onPress={onRetry}>
          <Text>重试</Text>
        </Button>
      </View>
    )
  }

  return (
    <View className="flex-row items-center gap-3">
      <Input
        value={code}
        onChangeText={onChangeCode}
        autoCapitalize="none"
        autoCorrect={false}
        className="flex-1"
        placeholder="验证码"
        onSubmitEditing={onSubmit}
        testID="login-captcha"
      />
      {/* 后端给的是**裸 base64**，不带 `data:` 前缀 —— 要自己拼，
          少拼的话 Image 静默什么都不显示（不报错） */}
      <Button variant="outline" className="h-12 w-28 p-0" onPress={onRetry} testID="login-captcha-image">
        <Image
          source={{ uri: `data:image/jpeg;base64,${state.image}` }}
          style={{ width: 106, height: 42, borderRadius: 6 }}
          resizeMode="contain"
        />
      </Button>
    </View>
  )
}

/** 三个登录方式的页签。用一条底边下划线标记选中，不用填充块 —— 和整屏的克制一致 */
function MethodTabs({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  return (
    <View className="border-line flex-row border-b">
      {METHODS.map((m) => {
        const active = m.value === value
        return (
          <Pressable
            key={m.value}
            onPress={() => onChange(m.value)}
            testID={`login-method-${m.value}`}
            className="flex-1 flex-row items-center justify-center gap-1.5 py-3.5"
          >
            <Icon as={m.icon} className={`size-3.5 ${active ? 'text-accent' : 'text-faint'}`} />
            <Text className={`text-[13px] ${active ? 'text-ink font-medium' : 'text-faint'}`}>{m.label}</Text>
            {/* 选中标记是一条压在分隔线上的短横 —— 结构件仍然只有「线」这一种 */}
            <View className={`absolute right-0 bottom-0 left-0 h-0.5 ${active ? 'bg-accent' : ''}`} />
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * 还没接入的登录方式：说清楚为什么不能用，并把人送回能用的那条。
 * 措辞和 web 端 `_guest/sign-in.tsx` 的 `NotWired` 保持一致。
 */
function NotWired({ method, onUsePassword }: { method: Method; onUsePassword: () => void }) {
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
    <View className="items-center gap-3 px-6 py-10">
      <Icon as={copy.icon} className="text-faint size-7" />
      <Text className="text-ink text-center text-sm font-medium">{copy.title}</Text>
      <Text className="text-faint text-center text-xs leading-5">{copy.hint}</Text>
      <Button size="sm" variant="outline" onPress={onUsePassword} className="mt-1">
        <Text>用密码登录</Text>
      </Button>
    </View>
  )
}
