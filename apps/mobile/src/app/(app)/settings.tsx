import { CheckIcon, ChevronRightIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { Chevron, Group, GroupHeader, PressRow, Row } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { APPEARANCE_LABEL, type Appearance, appearanceStore, useAppearance } from '@/lib/appearance'
import { BRAND } from '@/lib/brand'
import { useServer } from '@/lib/server'
import { useSession } from '@/lib/session'
import { useRouter } from 'expo-router'

const APPEARANCES: Appearance[] = ['system', 'light', 'dark']

export default function SettingsScreen() {
  const appearance = useAppearance()
  const { base, isCustom } = useServer()
  const { user } = useSession()
  const router = useRouter()

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="pb-10">
      <GroupHeader>外观</GroupHeader>
      <Group>
        {APPEARANCES.map((v, i) => (
          <PressRow key={v} first={i === 0} onPress={() => void appearanceStore.set(v)}>
            <Text className="flex-1 text-[15px]">{APPEARANCE_LABEL[v]}</Text>
            {/* iOS 的单选就是一枚对勾，不是圆点也不是开关 */}
            {appearance === v ? <Icon as={CheckIcon} className="text-primary size-[18px]" /> : null}
          </PressRow>
        ))}
      </Group>

      <GroupHeader>显示时区</GroupHeader>
      <Group>
        <PressRow first onPress={() => router.push('/timezone')}>
          <Text className="flex-1 text-[15px]">时区</Text>
          <Text className="text-muted-foreground font-mono text-xs">{user?.timezone ?? '—'}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>
      <Text className="text-muted-foreground px-5 pt-2 text-xs leading-5">
        影响所有时间的显示。这是账号级设置，和 web 端共用一份。
      </Text>

      <GroupHeader>服务器</GroupHeader>
      <Group>
        <PressRow first onPress={() => router.push('/server')}>
          <Text className="flex-1 text-[15px]">地址</Text>
          <Text className="text-muted-foreground shrink font-mono text-xs" numberOfLines={1}>
            {base}
          </Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>
      <Text className="text-muted-foreground px-5 pt-2 text-xs leading-5">
        {isCustom ? '已自定义。' : '用的是打包时的默认地址。'}
        改地址会退出当前登录 —— token 是跟着服务器发的。
      </Text>

      <GroupHeader>关于</GroupHeader>
      <Group>
        <Row first>
          <Text className="flex-1 text-[15px]">版本</Text>
          <Text className="text-muted-foreground font-mono text-xs">{BRAND.version}</Text>
        </Row>
        <Row>
          <Text className="flex-1 text-[15px]">技术栈</Text>
          <Text className="text-muted-foreground shrink font-mono text-[10px]" numberOfLines={1}>
            {BRAND.stack.join(' · ')}
          </Text>
        </Row>
      </Group>
    </ScrollView>
  )
}
