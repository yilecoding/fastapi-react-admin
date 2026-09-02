import { CheckIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'

import { Group, GroupHeader, PressRow } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * 显示时区。
 *
 * ⚠️ 这是**账号级**设置（`PUT /sys/users/me/timezone`），和 web 端共用一份 ——
 * 不是本机偏好。所以改完要 `reload()` 把 `/me` 拉回来，别只改本地状态。
 *
 * 🔴 后端入参是 `IanaTimeZone`，会校验；随手传一个拼错的名字会 422。
 * 所以这里给的是**一个列表**而不是输入框 —— 手输时区名是最容易打错的那类字段，
 * 而存进一个拼错的时区会让那个用户所有带时间的页面白屏（后端注释里记着这次实测）。
 */
/** ⚠️ `label` 是 **key**，不在这里 `t()` —— 模块级常量切语言不会变 */
const ZONES = [
  { id: 'Asia/Shanghai', label: '中国标准时间', offset: 'UTC+8' },
  { id: 'Asia/Hong_Kong', label: '香港', offset: 'UTC+8' },
  { id: 'Asia/Taipei', label: '台北', offset: 'UTC+8' },
  { id: 'Asia/Tokyo', label: '东京', offset: 'UTC+9' },
  { id: 'Asia/Singapore', label: '新加坡', offset: 'UTC+8' },
  { id: 'Asia/Dubai', label: '迪拜', offset: 'UTC+4' },
  { id: 'Europe/London', label: '伦敦', offset: 'UTC+0/+1' },
  { id: 'Europe/Paris', label: '巴黎', offset: 'UTC+1/+2' },
  { id: 'America/New_York', label: '纽约', offset: 'UTC−5/−4' },
  { id: 'America/Los_Angeles', label: '洛杉矶', offset: 'UTC−8/−7' },
  { id: 'UTC', label: '协调世界时', offset: 'UTC+0' },
] as const

export default function TimezoneScreen() {
  const { t } = useTranslation()
  const { user, reload } = useSession()
  const [saving, setSaving] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function pick(id: string) {
    if (saving || id === user?.timezone) return
    setSaving(id)
    setError(null)
    try {
      await api.PUT('/api/v1/sys/users/me/timezone', { timezone: id })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(null)
    }
  }

  const current = user?.timezone
  const known = ZONES.some((z) => z.id === current)

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="pb-10">
      {error ? (
        <View className="px-4 pt-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('没保存成功')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </View>
      ) : null}

      {/* 账号上的时区不在列表里时要显示出来 —— 不然用户看到「一个都没选中」，
          会以为设置丢了。列表是常用项，不是全集 */}
      {current && !known ? (
        <>
          <GroupHeader>{t('当前')}</GroupHeader>
          <Group>
            <PressRow first>
              <Text className="flex-1 font-mono text-[13px]">{current}</Text>
              <Icon as={CheckIcon} className="text-primary size-[18px]" />
            </PressRow>
          </Group>
          <Text className="text-muted-foreground px-5 pt-2 text-xs">
            {t('这个时区不在下面的常用列表里，是在 web 端设置的。')}
          </Text>
        </>
      ) : null}

      <GroupHeader>{t('常用时区')}</GroupHeader>
      <Group>
        {ZONES.map((z, i) => (
          <PressRow key={z.id} first={i === 0} onPress={() => void pick(z.id)}>
            <View className="flex-1">
              <Text className="text-[15px]">{t(z.label)}</Text>
              <Text className="text-muted-foreground font-mono text-[11px]">{z.id}</Text>
            </View>
            <Text className="text-muted-foreground font-mono text-[11px]">{z.offset}</Text>
            {saving === z.id ? (
              <ActivityIndicator size="small" />
            ) : current === z.id ? (
              <Icon as={CheckIcon} className="text-primary size-[18px]" />
            ) : null}
          </PressRow>
        ))}
      </Group>
    </ScrollView>
  )
}
