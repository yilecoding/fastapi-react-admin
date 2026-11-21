import { useTranslation } from 'react-i18next'
import { TriangleAlertIcon } from 'lucide-react-native'
import * as React from 'react'
import { ActivityIndicator, View } from 'react-native'

import { Group, GroupHeader, PressRow, Row } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { API_BASE_DEFAULT } from '@/lib/config'
import { useServer } from '@/lib/server'
import { serverBaseUrl } from '@/lib/server-url'
import { useSession } from '@/lib/session'

/** 探测的超时。连不上的地址 RN 的 fetch 自己要等 10～60 秒，按钮一直转着像卡死；Hermes 没有 `AbortSignal.timeout()` */
const PROBE_TIMEOUT_MS = 10_000

/**
 * 服务器地址表单 —— 设置屏（`(app)/server.tsx`，已登录）和登录屏（未登录）共用一份（#406）。
 *
 * 🔴 **未登录也必须改得了。** 原来这张表单只在已登录那棵树里，而保存时会先登出：
 * 存进去的服务器之后连不上（预发下线 / 域名迁移 / 离开内网），或者在那台服务器上没账号，
 * 就停在登录屏改不回来 —— Android 只能清数据，iOS 的 Keychain 还可能跨重装留着地址。
 *
 * 🔴 **保存前必须先探一下能不能连上。** 存一个打不通的地址进去，下一个动作
 * 是「登录失败」——那个报错完全不提是地址错了，用户会一直去试账号密码。
 * 所以这里先打 `/api/v1/auth/captcha`（无需鉴权、一定存在），通了再存。
 *
 * 🔴 **保存成功要清掉旧服务器的凭据**（`switchServer`）：token 是跟着服务器发的，换了服务器旧 token 一定无效；
 * cookie jar 里旧服务器的 refresh cookie 要记「待撤销」，否则以后切回去冷启动会被静默登回去（#319）。
 */
export function ServerForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation()
  const { base, isCustom } = useServer()
  const { switchServer } = useSession()
  const [value, setValue] = React.useState(base)
  const [probing, setProbing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const normalized = serverBaseUrl(value)
  const changed = normalized !== null && normalized !== base

  async function save() {
    if (!normalized || probing) return
    setProbing(true)
    setError(null)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await fetch(`${normalized}/api/v1/auth/captcha`, { method: 'GET', signal: controller.signal })
      } catch (err) {
        throw controller.signal.aborted ? new Error(t('{{s}} 秒内没有响应', { s: PROBE_TIMEOUT_MS / 1000 })) : err
      }
      if (!res.ok) throw new Error(t('服务器返回 HTTP {{code}}', { code: res.status }))
      const body = (await res.json().catch(() => null)) as { code?: number } | null
      // FBA 的所有响应都带 code；不带说明这不是本项目的后端
      if (typeof body?.code !== 'number') throw new Error(t('这个地址不像是本项目的后端'))
      await switchServer(normalized === API_BASE_DEFAULT ? null : normalized)
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
      setProbing(false)
    }
  }

  async function reset() {
    await switchServer(null)
    setValue(API_BASE_DEFAULT)
    onDone?.()
  }

  return (
    <View className="gap-4">
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
        {t('要带协议（https://）。生产必须是域名 + HTTPS —— 证书是签给域名的，走 IP 会 TLS 失败，而 RN 报的只是一句笼统的「连不上」。')}
      </Text>

      {value.trim() && !normalized ? (
        <Text className="text-destructive px-5 text-xs leading-5" testID="server-invalid">
          {t('地址格式不对：要以 http:// 或 https:// 开头，不能带 ? # 或账号密码')}
        </Text>
      ) : null}

      {error ? (
        <View className="px-4">
          <Alert variant="destructive" icon={TriangleAlertIcon} testID="server-error">
            <AlertTitle>{t('连不上这个地址')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </View>
      ) : null}

      <View className="gap-3 px-4 pt-1">
        <Button
          disabled={!changed || probing}
          onPress={() => void save()}
          testID="server-save"
          className="h-[50px] rounded-xl"
        >
          {probing ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Text className="text-base font-semibold">{probing ? t('正在连…') : t('测试并保存')}</Text>
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
    </View>
  )
}
