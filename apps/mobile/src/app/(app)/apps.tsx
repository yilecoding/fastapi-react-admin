import { LayoutGridIcon } from 'lucide-react-native'
import { ScrollView } from 'react-native'

import { EmptyState } from '@/components/empty-state'

export default function AppsScreen() {
  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="p-4">
      <EmptyState
        icon={LayoutGridIcon}
        title="还没有可用的应用"
        description="这里将来按权限列出可进入的功能模块。要先定移动端需要哪几个屏（issue #39 第 2 条），再决定这一屏列什么。"
      />
    </ScrollView>
  )
}
