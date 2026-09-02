import { CheckIcon, ChevronRightIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { Chevron, Group, GroupHeader, PressRow, Row } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { LANGUAGES, changeLanguage, type Language } from '@admin/i18n'

import { APPEARANCE_LABEL, type Appearance, appearanceStore, useAppearance } from '@/lib/appearance'
import { BRAND } from '@/lib/brand'
import { useServer } from '@/lib/server'
import { useSession } from '@/lib/session'
import { useRouter } from 'expo-router'

const APPEARANCES: Appearance[] = ['system', 'light', 'dark']

export default function SettingsScreen() {
  const { t, i18n } = useTranslation()
  const appearance = useAppearance()
  const { base, isCustom } = useServer()
  const { user } = useSession()
  const router = useRouter()

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="pb-10">
      <GroupHeader>{t('语言')}</GroupHeader>
      <Group>
        {LANGUAGES.map((l, i) => (
          <PressRow key={l.value} first={i === 0} onPress={() => void changeLanguage(l.value as Language)}>
            {/* 语言名**不翻译** —— 「English」在中文界面里也该显示 English，
                否则找不到自己那一项。这是 i18n 里少数刻意不 t() 的地方 */}
            <Text className="flex-1 text-[15px]">{l.label}</Text>
            {i18n.language === l.value ? <Icon as={CheckIcon} className="text-primary size-[18px]" /> : null}
          </PressRow>
        ))}
      </Group>

      <GroupHeader>{t('外观')}</GroupHeader>
      <Group>
        {APPEARANCES.map((v, i) => (
          <PressRow key={v} first={i === 0} onPress={() => void appearanceStore.set(v)}>
            <Text className="flex-1 text-[15px]">{t(APPEARANCE_LABEL[v])}</Text>
            {/* iOS 的单选就是一枚对勾，不是圆点也不是开关 */}
            {appearance === v ? <Icon as={CheckIcon} className="text-primary size-[18px]" /> : null}
          </PressRow>
        ))}
      </Group>

      <GroupHeader>{t('显示时区')}</GroupHeader>
      <Group>
        <PressRow first onPress={() => router.push('/timezone')}>
          <Text className="flex-1 text-[15px]">{t('时区')}</Text>
          <Text className="text-muted-foreground font-mono text-xs">{user?.timezone ?? '—'}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>
      <Text className="text-muted-foreground px-5 pt-2 text-xs leading-5">
        {t('影响所有时间的显示。这是账号级设置，和 web 端共用一份。')}
      </Text>

      <GroupHeader>{t('服务器')}</GroupHeader>
      <Group>
        <PressRow first onPress={() => router.push('/server')}>
          <Text className="flex-1 text-[15px]">{t('地址')}</Text>
          <Text className="text-muted-foreground shrink font-mono text-xs" numberOfLines={1}>
            {base}
          </Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>
      <Text className="text-muted-foreground px-5 pt-2 text-xs leading-5">
        {t(isCustom ? '已自定义。' : '用的是打包时的默认地址。')}
        改地址会退出当前登录 —— token 是跟着服务器发的。
      </Text>

      <GroupHeader>{t('关于')}</GroupHeader>
      <Group>
        <Row first>
          <Text className="flex-1 text-[15px]">{t('版本')}</Text>
          <Text className="text-muted-foreground font-mono text-xs">{BRAND.version}</Text>
        </Row>
        <Row>
          <Text className="flex-1 text-[15px]">{t('技术栈')}</Text>
          <Text className="text-muted-foreground shrink font-mono text-[10px]" numberOfLines={1}>
            {BRAND.stack.join(' · ')}
          </Text>
        </Row>
      </Group>
    </ScrollView>
  )
}
