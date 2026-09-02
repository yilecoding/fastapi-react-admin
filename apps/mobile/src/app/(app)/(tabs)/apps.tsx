import { LayoutGridIcon } from 'lucide-react-native'
import { ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'

export default function AppsScreen() {
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 12 }}
      contentContainerClassName="gap-4 px-4 pb-10"
    >
      <Card>
        <CardHeader>
          <CardTitle>应用</CardTitle>
          <CardDescription>按你的权限列出能进的功能模块</CardDescription>
        </CardHeader>
        {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」 */}
        <CardContent className="items-center gap-2 py-8">
          <Icon as={LayoutGridIcon} className="text-muted-foreground size-8" />
          <Text variant="small" className="text-muted-foreground">
            还没有可用的应用
          </Text>
          <Text className="text-muted-foreground text-center text-xs leading-5">
            要先定移动端需要哪几个屏，再决定这一块列什么
          </Text>
        </CardContent>
      </Card>
    </ScrollView>
  )
}
