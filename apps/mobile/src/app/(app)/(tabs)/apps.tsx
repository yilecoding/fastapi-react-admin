import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Rail, RailSection } from '@/components/rail'
import { Text } from '@/components/ui/text'

export default function AppsScreen() {
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      className="bg-panel flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 20 }}
      contentContainerClassName="px-6 pb-12"
    >
      <Text className="text-ink text-[28px] font-semibold" style={{ letterSpacing: -0.9 }}>
        应用
      </Text>
      <Text className="text-dim mt-1.5 text-[14px]">按你的权限列出能进的功能模块</Text>

      <Rail className="mt-6">
        <RailSection label="可用模块" />
        <View className="py-10">
          <Text className="text-dim text-[14px]">还没有可用的应用</Text>
          <Text className="text-faint mt-1.5 text-[12px] leading-5">
            要先定移动端需要哪几个屏，再决定这一段列什么
          </Text>
        </View>
      </Rail>
    </ScrollView>
  )
}
