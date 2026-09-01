import { Stack } from 'expo-router'
import * as React from 'react'
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { ApiError, api } from '@/lib/api'
import type { Captcha } from '@/lib/contract'
import { useSession } from '@/lib/session'

/**
 * 验证码的状态机 —— 抄的是根 `CLAUDE.md` 硬纪律 9 那条，因为 web 登录页就是在
 * 这里踩过：`catch {}` 里把验证码字段藏掉，限流 429 被吞 → 字段消失 →
 * 后端仍强制校验 → 用户拿到一个怎么点都登不进去、还看不出原因的表单。
 *
 * `off` **只给「服务端明确说关了」这一种情况**（`is_enabled === false`），
 * 失败一律是 `error` + 重试入口。
 */
type CaptchaState =
  | { kind: 'loading' }
  | { kind: 'ready'; uuid: string; image: string }
  | { kind: 'off' }
  | { kind: 'error'; msg: string }

export default function LoginScreen() {
  const { login, bootstrapError } = useSession()

  const [username, setUsername] = React.useState('admin')
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
        // Android 上键盘遮挡输入框是最常见的移动端落差之一（issue #39 第 2.5 节
        // 六条里的一条）。两个平台的行为不同，behavior 要分开给。
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="bg-background flex-1"
      >
        <ScrollView
          contentContainerClassName="min-h-full justify-center gap-6 p-6"
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-1">
            <Text className="text-foreground text-3xl font-semibold">中后台</Text>
            <Text className="text-muted-foreground text-sm">登录后使用</Text>
          </View>

          {bootstrapError ? (
            <View className="border-destructive/40 bg-destructive/10 gap-1 rounded-md border p-3">
              <Text className="text-foreground text-sm font-medium">启动时没能连上服务器</Text>
              <Text className="text-muted-foreground text-xs">{bootstrapError}</Text>
            </View>
          ) : null}

          <View className="gap-4">
            <Field label="用户名">
              <Input
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="username"
                placeholder="用户名"
                testID="login-username"
              />
            </Field>

            <Field label="密码">
              <Input
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                textContentType="password"
                placeholder="密码"
                onSubmitEditing={() => void submit()}
                testID="login-password"
              />
            </Field>

            <CaptchaBlock
              state={captcha}
              code={code}
              onChangeCode={setCode}
              onRetry={() => void loadCaptcha()}
              onSubmit={() => void submit()}
            />
          </View>

          {error ? (
            <Text className="text-destructive text-sm" testID="login-error">
              {error}
            </Text>
          ) : null}

          <Button disabled={!canSubmit} onPress={() => void submit()} testID="login-submit">
            {submitting ? <ActivityIndicator size="small" /> : null}
            <Text>{submitting ? '登录中…' : '登录'}</Text>
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
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
      <View className="h-11 flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text className="text-muted-foreground text-sm">正在取验证码…</Text>
      </View>
    )
  }

  if (state.kind === 'error') {
    return (
      <View className="border-destructive/40 bg-destructive/10 gap-2 rounded-md border p-3">
        <Text className="text-foreground text-sm">验证码没取到：{state.msg}</Text>
        <Button size="sm" variant="outline" onPress={onRetry}>
          <Text>重试</Text>
        </Button>
      </View>
    )
  }

  return (
    <Field label="验证码">
      <View className="flex-row items-center gap-3">
        <Input
          value={code}
          onChangeText={onChangeCode}
          autoCapitalize="none"
          autoCorrect={false}
          className="flex-1"
          placeholder="图片里的字符"
          onSubmitEditing={onSubmit}
          testID="login-captcha"
        />
        {/* 后端给的是**裸 base64**，不带 `data:` 前缀 —— 要自己拼，
            少拼的话 Image 静默什么都不显示（不报错） */}
        <Button variant="ghost" size="icon" className="h-11 w-28" onPress={onRetry} testID="login-captcha-image">
          <Image
            source={{ uri: `data:image/jpeg;base64,${state.image}` }}
            style={{ width: 108, height: 40, borderRadius: 6 }}
            resizeMode="contain"
          />
        </Button>
      </View>
    </Field>
  )
}
