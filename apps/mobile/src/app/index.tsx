import { Stack } from 'expo-router'
import * as React from 'react'
import { Platform, ScrollView, TextInput, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Text } from '@/components/ui/text'
import { API_BASE } from '@/lib/probe-config'

/**
 * C 路线底座的探针页 —— 一次性的，两条实测跑完就换成真页面。
 *
 * 它回答 issue #39 里两个**只能在设备上回答**的问题：
 *   1. uniwind 认不认 `oklch()`  → 设计令牌能不能和 web 共享一份真相源
 *   2. RN 的 `fetch` 能不能读到 `set-cookie` / cookie jar 会不会自动回传
 *      → 后端要不要为移动端改刷新链路
 */

const PROBE_PAIRS = [
  { key: 'a', oklch: 'bg-probe-a-oklch', srgb: 'bg-probe-a-srgb', label: 'oklch(0.62 0.19 250) / #0088F2' },
  { key: 'b', oklch: 'bg-probe-b-oklch', srgb: 'bg-probe-b-srgb', label: 'oklch(0.72 0.19 145) / #43C251' },
  { key: 'c', oklch: 'bg-probe-c-oklch', srgb: 'bg-probe-c-srgb', label: 'oklch(0.65 0.24 20) / #FF2C4D' },
] as const

export default function ProbeScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'C 路线探针' }} />
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-6 p-4 pb-16">
        <OklchProbe />
        <CookieProbe />
        <Text className="text-muted-foreground text-xs">
          {`RN ${Platform.constants.reactNativeVersion.major}.${Platform.constants.reactNativeVersion.minor}.${Platform.constants.reactNativeVersion.patch} · ${Platform.OS} ${Platform.Version}`}
        </Text>
      </ScrollView>
    </>
  )
}

function OklchProbe() {
  return (
    <View className="gap-3">
      <Text className="text-foreground text-lg font-semibold">1 · oklch 探针</Text>
      <Text className="text-muted-foreground text-sm">
        每行左右两块是同一个颜色的两种写法。看不出接缝 = RN 认 oklch；左块透明/发黑/明显偏色 = 不认。
      </Text>
      {PROBE_PAIRS.map((pair) => (
        <View key={pair.key} className="gap-1" testID={`probe-pair-${pair.key}`}>
          <View className="h-16 flex-row overflow-hidden rounded-md">
            <View className={`flex-1 ${pair.oklch}`} testID={`probe-oklch-${pair.key}`} />
            <View className={`flex-1 ${pair.srgb}`} testID={`probe-srgb-${pair.key}`} />
          </View>
          <Text className="text-muted-foreground font-mono text-xs">{pair.label}</Text>
        </View>
      ))}
    </View>
  )
}

type Line = { at: number; text: string }

function CookieProbe() {
  const [uuid, setUuid] = React.useState('')
  const [captcha, setCaptcha] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  const seq = React.useRef(0)

  function say(text: string) {
    seq.current += 1
    const at = seq.current
    setLines((prev) => [...prev, { at, text }])
  }

  /** 把 Headers 摊平成可读的行 —— 重点是 set-cookie 这个 key 到底在不在。 */
  function dumpHeaders(res: Response) {
    const keys: string[] = []
    res.headers.forEach((_value, key) => keys.push(key))
    say(`  headers: ${keys.sort().join(', ') || '(空)'}`)
    const raw = res.headers.get('set-cookie')
    say(`  set-cookie: ${raw === null ? '❌ 读不到（null）' : `✅ 读到了 → ${raw}`}`)
  }

  async function step1Captcha() {
    say('GET /auth/captcha …')
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/captcha`)
      const body = await res.json()
      say(`  ${res.status} is_enabled=${String(body?.data?.is_enabled)}`)
      const got = body?.data?.uuid ?? ''
      setUuid(got)
      say(got ? `  uuid=${got}（去 redis 取答案）` : '  没有 uuid —— 验证码是关的，captcha 留空直接登录')
    } catch (err) {
      say(`  ❌ ${String(err)}`)
    }
  }

  async function step2Login() {
    say('POST /auth/login …')
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: '123456', uuid, captcha }),
      })
      const body = await res.json()
      say(`  ${res.status} access_token=${body?.data?.access_token ? '有' : '无'} msg=${body?.msg ?? ''}`)
      dumpHeaders(res)
    } catch (err) {
      say(`  ❌ ${String(err)}`)
    }
  }

  async function step3Refresh() {
    // 刻意不带任何头：/auth/refresh 只读 refresh cookie。
    // 200 = RN 的 cookie jar 自动回传了；401 = 没回传，后端要为移动端改链路。
    say('POST /auth/refresh（不带任何头，只靠 cookie jar）…')
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST' })
      const body = await res.json()
      say(`  ${res.status} ${res.ok ? '✅ cookie 自动回传了' : `❌ 没回传 · msg=${body?.msg ?? ''}`}`)
      dumpHeaders(res)
    } catch (err) {
      say(`  ❌ ${String(err)}`)
    }
  }

  return (
    <View className="gap-3">
      <Text className="text-foreground text-lg font-semibold">2 · set-cookie / cookie jar 探针</Text>
      <Text className="text-muted-foreground text-sm">{API_BASE}</Text>
      <View className="flex-row gap-2">
        <TextInput
          className="border-border text-foreground flex-1 rounded-md border px-3 py-2"
          placeholder="验证码"
          autoCapitalize="none"
          value={captcha}
          onChangeText={setCaptcha}
          testID="probe-captcha-input"
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button size="sm" onPress={step1Captcha} testID="probe-step-captcha">
          <Text>1 取验证码</Text>
        </Button>
        <Button size="sm" onPress={step2Login} testID="probe-step-login">
          <Text>2 登录</Text>
        </Button>
        <Button size="sm" onPress={step3Refresh} testID="probe-step-refresh">
          <Text>3 刷新</Text>
        </Button>
        <Button size="sm" variant="ghost" onPress={() => setLines([])}>
          <Text>清空</Text>
        </Button>
      </View>
      <View className="bg-muted gap-0.5 rounded-md p-3" testID="probe-log">
        {lines.length === 0 ? (
          <Text className="text-muted-foreground font-mono text-xs">（还没跑）</Text>
        ) : (
          lines.map((line) => (
            <Text key={line.at} className="text-foreground font-mono text-xs">
              {line.text}
            </Text>
          ))
        )}
      </View>
    </View>
  )
}
