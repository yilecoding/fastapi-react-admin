import { useRouter } from 'expo-router'
import { BellIcon, ChevronRightIcon, InboxIcon, UserRoundIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Separator } from '@/components/ui/separator'
import { Text } from '@/components/ui/text'
import { useUnread } from '@/lib/notifications'
import { useSession } from '@/lib/session'

export default function HomeScreen() {
  const { user, reload } = useSession()
  const { unread, refresh: refreshUnread } = useUnread()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)

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
      className="bg-background flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 12 }}
      contentContainerClassName="gap-4 px-4 pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <View className="flex-row items-center gap-3 px-1 py-2">
        <Avatar alt={user?.nickname ?? ''} className="size-11">
          {user?.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
          <AvatarFallback>
            <Text className="font-semibold">
              {(user?.nickname || user?.username || '?').slice(0, 1).toUpperCase()}
            </Text>
          </AvatarFallback>
        </Avatar>
        <View className="flex-1">
          <Text variant="small" className="text-muted-foreground">
            {greeting()}
          </Text>
          <Text className="text-xl font-semibold">{user?.nickname || user?.username || ''}</Text>
        </View>
      </View>

      <Card>
        <CardHeader>
          <CardTitle>我的组织</CardTitle>
          <CardDescription>部门与角色决定你能进哪、能看到哪些数据</CardDescription>
        </CardHeader>
        <CardContent className="flex-row gap-3">
          <Stat label="部门" value={user?.dept ?? '—'} />
          <Separator orientation="vertical" />
          <Stat label="角色" value={user?.roles.join('、') || '—'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>快捷入口</CardTitle>
        </CardHeader>
        <CardContent className="gap-0 px-0">
          <Entry
            icon={BellIcon}
            label="通知"
            badge={total}
            hint={total > 0 ? undefined : '没有未读'}
            onPress={() => router.push('/notifications')}
            first
          />
          <Entry icon={UserRoundIcon} label="个人中心" hint="资料 · 密码 · 登出" onPress={() => router.push('/profile')} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>待办与动态</CardTitle>
        </CardHeader>
        {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」——
            三者在用户眼里都是一片空，分不清的第一反应是「这 App 坏了」 */}
        <CardContent className="items-center gap-2 py-6">
          <Icon as={InboxIcon} className="text-muted-foreground size-7" />
          <Text variant="small" className="text-muted-foreground text-center">
            还没有内容
          </Text>
          <Text className="text-muted-foreground text-center text-xs leading-5">
            等移动端要哪几个功能定下来再填这一块
          </Text>
        </CardContent>
      </Card>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1 gap-1">
      <Text className="text-muted-foreground text-xs">{label}</Text>
      <Text className="font-medium" numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

function Entry({
  icon,
  label,
  hint,
  badge = 0,
  onPress,
  first,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  label: string
  hint?: string
  badge?: number
  onPress: () => void
  first?: boolean
}) {
  return (
    <>
      {first ? null : <Separator className="my-0" />}
      <Pressable
        onPress={onPress}
        className="active:bg-accent min-h-[48px] flex-row items-center gap-3 px-6 py-2.5"
      >
        <Icon as={icon} className="text-muted-foreground size-4" />
        <Text className="flex-1 text-sm">{label}</Text>
        {badge > 0 ? (
          <Badge>
            <Text>{badge > 99 ? '99+' : badge}</Text>
          </Badge>
        ) : hint ? (
          <Text className="text-muted-foreground text-xs">{hint}</Text>
        ) : null}
        <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
      </Pressable>
    </>
  )
}
