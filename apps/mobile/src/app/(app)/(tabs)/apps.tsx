import { LayoutGridIcon } from 'lucide-react-native'
import { ScrollView, View } from 'react-native'

import { EmptyState } from '@/components/empty-state'
import { Card, CardLabel } from '@/components/ui/card'

export default function AppsScreen() {
  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="gap-6 p-4 pb-10">
      <View>
        <CardLabel>可用应用</CardLabel>
        <Card>
          <EmptyState
            icon={LayoutGridIcon}
            title="还没有可用的应用"
            description="这里将来按权限列出可进入的功能模块。要先定移动端需要哪几个屏（issue #39 第 2 条），再决定这一屏列什么。"
          />
        </Card>
      </View>
    </ScrollView>
  )
}
