import { useRouter } from 'expo-router'
import { BellIcon, ChevronRightIcon, InboxIcon, UserRoundIcon } from 'lucide-react-native'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import { BrandTop } from '@/components/brand-top'
import { Chevron, Group, GroupHeader, PressRow, Row, RowIcon } from '@/components/grouped'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { useUnread } from '@/lib/notifications'
import { useSession } from '@/lib/session'

export default function HomeScreen() {
  const { user, reload } = useSession()
  const { unread, refresh: refreshUnread } = useUnread()
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
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <BrandTop>
        <View className="gap-1 pt-1">
          <Text className="text-muted-foreground text-[13px]">{greeting()}</Text>
          {/* iOS 大标题 */}
          <Text className="text-3xl font-bold" style={{ letterSpacing: -0.9 }}>
            {user?.nickname || user?.username || ''}
          </Text>
        </View>
      </BrandTop>

      <GroupHeader>我的组织</GroupHeader>
      <Group>
        <Row first>
          <Text className="shrink-0 text-[15px]">部门</Text>
          <Text className="text-muted-foreground flex-1 text-right text-[14px]">{user?.dept ?? '—'}</Text>
        </Row>
        <Row>
          <Text className="shrink-0 text-[15px]">角色</Text>
          <Text className="text-muted-foreground flex-1 text-right text-[14px]">
            {user?.roles.join('、') || '—'}
          </Text>
        </Row>
        <Row>
          <Text className="shrink-0 text-[15px]">时区</Text>
          <Text className="text-muted-foreground flex-1 text-right font-mono text-xs">
            {user?.timezone ?? '—'}
          </Text>
        </Row>
      </Group>

      <GroupHeader>入口</GroupHeader>
      <Group>
        <PressRow first inset={56} onPress={() => router.push('/notifications')}>
          <RowIcon icon={BellIcon} active={total > 0} />
          <Text className="flex-1 text-[15px]">通知</Text>
          {total > 0 ? (
            <Badge>
              <Text>{total > 99 ? '99+' : total}</Text>
            </Badge>
          ) : (
            <Text className="text-muted-foreground text-[13px]">没有未读</Text>
          )}
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
        <PressRow inset={56} onPress={() => router.push('/profile')}>
          <RowIcon icon={UserRoundIcon} />
          <Text className="flex-1 text-[15px]">个人中心</Text>
          <Text className="text-muted-foreground text-[13px]">资料 · 密码</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>

      <GroupHeader>待办与动态</GroupHeader>
      <Group className="items-center gap-2 py-8">
        {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」——
            三者在用户眼里都是一片空，分不清的第一反应是「这 App 坏了」 */}
        <Icon as={InboxIcon} className="text-muted-foreground size-7" />
        <Text variant="small" className="text-muted-foreground">
          还没有内容
        </Text>
        <Text className="text-muted-foreground/70 px-8 text-center text-xs leading-5">
          等移动端要哪几个功能定下来再填这一块
        </Text>
      </Group>
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
