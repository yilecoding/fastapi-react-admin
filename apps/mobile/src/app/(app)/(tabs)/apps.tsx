import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BrandBackdrop } from '@/components/brand-backdrop'
import { Eyebrow, SectionHead } from '@/components/ui/panel'
import { Text } from '@/components/ui/text'

export default function AppsScreen() {
  const insets = useSafeAreaInsets()
  return (
    <View className="bg-panel flex-1">
      <BrandBackdrop className="absolute top-0 right-0 left-0 h-56" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 20 }}
        contentContainerClassName="px-5 pb-12 gap-8"
      >
        <View>
          <Eyebrow>应用</Eyebrow>
          <Text className="text-ink mt-3 text-[26px] font-semibold" style={{ letterSpacing: -0.7 }}>
            按权限进入
          </Text>
        </View>

        <View className="gap-3">
          <SectionHead label="MODULES" />
          {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」——
              三者在用户眼里都是一片空，分不清的第一反应是「这 App 坏了」 */}
          <View className="py-10">
            <Text className="text-faint text-center text-sm">还没有可用的应用</Text>
            <Text className="text-faint mt-1.5 text-center text-xs leading-5">
              这里将来按权限列出能进的功能模块。{'\n'}要先定移动端需要哪几个屏，再决定这一屏列什么。
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
