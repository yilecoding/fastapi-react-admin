import { LayoutDashboardIcon } from 'lucide-react-native'
import { ScrollView, View } from 'react-native'

import { EmptyState } from '@/components/empty-state'
import { Text } from '@/components/ui/text'
import { useSession } from '@/lib/session'

export default function HomeScreen() {
  const { user } = useSession()

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="gap-6 p-4 pb-16">
      <View className="gap-1">
        <Text className="text-foreground text-2xl font-semibold">
          {user?.nickname || user?.username || ''}
        </Text>
        <Text className="text-muted-foreground text-sm">
          {user?.dept ? `${user.dept} · ` : ''}
          {user?.roles.join('、') || '暂无角色'}
        </Text>
      </View>

      <EmptyState
        icon={LayoutDashboardIcon}
        title="首页还没有内容"
        description="这里将来放待办、通知摘要和常用入口。现在只有导航壳和个人中心是通的，业务页面一个都还没做。"
      />
    </ScrollView>
  )
}
