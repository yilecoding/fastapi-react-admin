import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Section } from '@/components/ui/panel'
import { Text } from '@/components/ui/text'

export default function AppsScreen() {
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      className="bg-panel flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 12 }}
      contentContainerClassName="gap-6 px-4 pb-10"
    >
      <View className="px-1 pt-1">
        <Text className="text-ink text-[27px] font-semibold" style={{ letterSpacing: -0.8 }}>
          应用
        </Text>
        <Text className="text-dim mt-1.5 text-sm">按你的权限列出能进的功能模块</Text>
      </View>

      <Section label="可用模块">
        <View className="items-center gap-1.5 px-6 py-12">
          <Text className="text-dim text-sm">还没有可用的应用</Text>
          <Text className="text-faint text-center text-xs leading-5">
            要先定移动端需要哪几个屏，再决定这一屏列什么
          </Text>
        </View>
      </Section>
      
    </ScrollView>
  )
}
