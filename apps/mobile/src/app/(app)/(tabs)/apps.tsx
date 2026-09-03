import { LayoutGridIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { ScrollView, View } from 'react-native'

import { BrandTop } from '@/components/brand-top'
import { Group, GroupHeader } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'

export default function AppsScreen() {
  const { t } = useTranslation()
  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="pb-10">
      <BrandTop>
        <View className="gap-1 pt-1">
          <Text className="text-3xl font-bold" style={{ letterSpacing: -0.9 }}>
            {t('应用')}
          </Text>
          <Text className="text-muted-foreground text-[13px]">{t('按你的权限列出能进的功能模块')}</Text>
        </View>
      </BrandTop>

      <GroupHeader>{t('可用模块')}</GroupHeader>
      {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」 */}
      <Group className="items-center gap-2 py-10">
        <Icon as={LayoutGridIcon} className="text-muted-foreground size-8" />
        <Text variant="small" className="text-muted-foreground">
          {t('还没有可用的应用')}
        </Text>
        <Text className="text-muted-foreground/70 px-8 text-center text-xs leading-5">
          {t('要先定移动端需要哪几个屏，再决定这一块列什么')}
        </Text>
      </Group>

    </ScrollView>
  )
}
