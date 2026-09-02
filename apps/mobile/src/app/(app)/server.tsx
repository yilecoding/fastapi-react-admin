import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { TriangleAlertIcon } from 'lucide-react-native'
import * as React from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Group, GroupHeader, PressRow, Row } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { API_BASE_DEFAULT } from '@/lib/config'
import { serverStore, useServer } from '@/lib/server'
import { useSession } from '@/lib/session'

/**
 * 服务器地址设置。
 *
 * 🔴 **保存前必须先探一下能不能连上。** 存一个打不通的地址进去，下一个动作
 * 是「登录失败」——那个报错完全不提是地址错了，用户会一直去试账号密码。
 * 所以这里先打 `/api/v1/auth/captcha`（无需鉴权、一定存在），通了再存。
 *
 * 🔴 **保存成功要登出。** token 是跟着服务器发的，换了服务器旧 token 一定无效，
 * 而那个失败会表现成「莫名其妙 401」。
 */
export default function ServerScreen() {
  const { t } = useTranslation()
  const { base, isCustom } = useServer()
  const { logout } = useSession()
  const router = useRouter()
  const [value, setValue] = React.useState(base)
  const [probing, setProbing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const normalized = value.trim().replace(/\/+$/, '')
  const changed = normalized !== base
  const looksOk = /^https?:\/\/[^\s/]+/.test(normalized)

  async function save() {
    if (!looksOk || probing) return
    setProbing(true)
    setError(null)
    try {
      const res = await fetch(`${normalized}/api/v1/auth/captcha`, { method: 'GET' })
      if (!res.ok) throw new Error(`服务器返回 HTTP ${res.status}`)
      const body = (await res.json()) as { code?: number }
      // FBA 的所有响应都带 code；不带说明这不是本项目的后端
      if (typeof body?.code !== 'number') throw new Error(t('这个地址不像是本项目的后端'))
      await serverStore.set(normalized === API_BASE_DEFAULT ? null : normalized)
      await logout()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }

  async function reset() {
    await serverStore.set(null)
    setValue(API_BASE_DEFAULT)
    await logout()
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="bg-background flex-1"
    >
      <ScrollView contentContainerClassName="gap-4 py-4" keyboardShouldPersistTaps="handled">
        <Group>
          <Row first>
            <Text className="w-[52px] shrink-0 text-[15px]">{t('地址')}</Text>
            <Input
              value={value}
              onChangeText={setValue}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://fra.wubunan.com"
              testID="server-input"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none font-mono text-[13px]"
            />
          </Row>
        </Group>

        <Text className="text-muted-foreground px-5 text-xs leading-5">
          要带协议（`https://`）。生产必须是域名 + HTTPS —— 证书是签给域名的，走 IP 会 TLS 失败，
          而 RN 报的只是一句笼统的「连不上」。
        </Text>

        {error ? (
          <View className="px-4">
            <Alert variant="destructive" icon={TriangleAlertIcon}>
              <AlertTitle>{t('连不上这个地址')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </View>
        ) : null}

        <View className="gap-3 px-4 pt-1">
          <Button
            disabled={!changed || !looksOk || probing}
            onPress={() => void save()}
            testID="server-save"
            className="h-[50px] rounded-xl"
          >
            {probing ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text className="text-base font-semibold">{t(probing ? '正在连…' : '测试并保存')}</Text>
          </Button>
          <Text className="text-muted-foreground px-1 text-xs leading-5">
            {t('保存前会先探一次这个地址；成功后会退出当前登录（token 跟着服务器发的）。')}
          </Text>
        </View>

        {isCustom ? (
          <>
            <GroupHeader>{t('恢复')}</GroupHeader>
            <Group>
              <PressRow first onPress={() => void reset()} testID="server-reset">
                <Text className="text-destructive flex-1 text-[15px]">{t('恢复默认地址')}</Text>
                <Text className="text-muted-foreground font-mono text-[11px]" numberOfLines={1}>
                  {API_BASE_DEFAULT}
                </Text>
              </PressRow>
            </Group>
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
