import { useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCSSVariable } from 'uniwind'

import { Rail, RailAction, RailRow, RailSection } from '@/components/rail'
import { TenonMark } from '@/components/tenon-mark'
import { Text } from '@/components/ui/text'
import { BRAND } from '@/lib/brand'
import { useUnread } from '@/lib/notifications'
import { useSession } from '@/lib/session'

export default function HomeScreen() {
  const { user, reload } = useSession()
  const { unread, refresh: refreshUnread } = useUnread()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)
  const faintVar = useCSSVariable('--color-faint')
  const faint = typeof faintVar === 'string' ? faintVar : '#888'

  async function onRefresh() {
    setRefreshing(true)
    try {
      await Promise.all([reload(), refreshUnread()])
    } catch {
      // 首页刷新失败不值得打断 —— 数据还是上一次那份，个人中心那屏有完整的错误态
    } finally {
      setRefreshing(false)
    }
  }

  const total = unread?.total ?? 0

  return (
    <ScrollView
      className="bg-panel flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 20 }}
      contentContainerClassName="px-6 pb-12"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <View className="flex-row items-center gap-2">
        <TenonMark size={14} color={faint} />
        <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 1.2 }}>
          {BRAND.wordmark}
        </Text>
      </View>

      <Text className="text-faint mt-7 text-[13px]">{greeting()}</Text>
      <Text className="text-ink mt-1 text-[28px] font-semibold" style={{ letterSpacing: -0.9 }}>
        {user?.nickname || user?.username || ''}
      </Text>

      <Rail className="mt-6">
        <RailRow label="部门" value={user?.dept} plain />
        <RailRow label="角色" value={user?.roles.join('、')} plain />
        <RailRow label="时区" value={user?.timezone} />

        <RailSection label="入口" />
        <RailAction
          label="通知"
          hint={total > 0 ? `${total} 条未读` : '无未读'}
          live={total > 0}
          onPress={() => router.push('/notifications')}
        />
        <RailAction label="个人中心" hint="资料 · 密码" onPress={() => router.push('/profile')} />

        <RailSection label="动态" />
        {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」——
            三者在用户眼里都是一片空，分不清的第一反应是「这 App 坏了」 */}
        <View className="py-8">
          <Text className="text-dim text-[14px]">还没有待办和动态</Text>
          <Text className="text-faint mt-1.5 text-[12px] leading-5">
            等移动端要哪几个功能定下来再填这一段
          </Text>
        </View>
      </Rail>
    </ScrollView>
  )
}

/** 按本机时间问好。刻意不查服务端时区 —— 问候语说的是「你现在」，不是账号设定的时区 */
function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}
