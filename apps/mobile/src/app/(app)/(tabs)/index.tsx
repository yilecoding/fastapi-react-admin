import { useRouter } from 'expo-router'
import { BellIcon, ClockIcon, LayoutDashboardIcon, ShieldCheckIcon, UserRoundIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { EmptyState } from '@/components/empty-state'
import { TenonMark } from '@/components/tenon-mark'
import { Card, CardLabel } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
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

  async function onRefresh() {
    setRefreshing(true)
    try {
      await Promise.all([reload(), refreshUnread()])
    } catch {
      // 首页的刷新失败不值得打断 —— 数据还是上一次那份，个人中心那屏有完整的错误态
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      {/* 品牌头 —— 和登录页同一块主色，进来之后视觉是连着的 */}
      <View className="bg-primary px-5 pb-8" style={{ paddingTop: insets.top + 16 }}>
        <View className="flex-row items-center gap-2">
          <TenonMark size={18} color="#fff" />
          <Text className="text-primary-foreground/70 text-xs tracking-wide">{BRAND.wordmark}</Text>
        </View>
        <Text className="text-primary-foreground mt-4 text-2xl font-semibold">
          {greeting()}，{user?.nickname || user?.username || ''}
        </Text>
        <Text className="text-primary-foreground/70 mt-1 text-sm">
          {[user?.dept, user?.roles.join('、')].filter(Boolean).join(' · ') || '暂无部门与角色'}
        </Text>
      </View>

      {/* 头部下方压一层卡片，制造深度 —— 移动端没有 hover，层次只能靠这个 */}
      <View className="-mt-4 gap-6 px-4 pt-0">
        <Card>
          <View className="flex-row">
            <Stat icon={ShieldCheckIcon} label="账号类型" value={accountKind(user)} />
            <View className="bg-border w-hairline" />
            <Stat icon={ClockIcon} label="时区" value={user?.timezone ?? '—'} />
          </View>
        </Card>

        <View>
          <CardLabel>快捷入口</CardLabel>
          <Card>
            <Entry
              first
              icon={UserRoundIcon}
              title="个人中心"
              subtitle="资料 · 密码 · 登出"
              onPress={() => router.push('/profile')}
            />
            <Entry
              icon={BellIcon}
              title="通知"
              subtitle={unread && unread.total > 0 ? `${unread.total} 条未读` : '没有未读'}
              badge={unread?.total ?? 0}
              onPress={() => router.push('/notifications')}
            />
          </Card>
        </View>

        <View>
          <CardLabel>待办与动态</CardLabel>
          <Card>
            <EmptyState
              icon={LayoutDashboardIcon}
              title="还没有内容"
              description="这里将来放待办、通知摘要和常用入口。现在只有导航壳和个人中心是通的。"
            />
          </Card>
        </View>
      </View>
    </ScrollView>
  )
}

/** 按本机时间问好。刻意不查服务端时区 —— 问候语说的是「你现在」，不是「账号设定的时区」 */
function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function accountKind(user: { is_superuser: boolean; is_staff: boolean } | null) {
  if (!user) return '—'
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  label: string
  value: string
}) {
  return (
    <View className="flex-1 gap-1.5 px-4 py-4">
      <View className="flex-row items-center gap-1.5">
        <Icon as={icon} className="text-muted-foreground size-3.5" />
        <Text className="text-muted-foreground text-xs">{label}</Text>
      </View>
      <Text className="text-foreground text-base font-medium" numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

function Entry({
  first,
  icon,
  title,
  subtitle,
  onPress,
  disabled,
  badge = 0,
}: {
  first?: boolean
  icon: React.ComponentProps<typeof Icon>['as']
  title: string
  subtitle: string
  onPress?: () => void
  disabled?: boolean
  badge?: number
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:bg-accent ${first ? '' : 'border-border border-t'} ${disabled ? 'opacity-45' : ''}`}
    >
      <View className="bg-primary/10 h-9 w-9 items-center justify-center rounded-full">
        <Icon as={icon} className="text-primary size-4.5" />
      </View>
      <View className="flex-1">
        <Text className="text-foreground text-sm font-medium">{title}</Text>
        <Text className="text-muted-foreground text-xs">{subtitle}</Text>
      </View>
      {badge > 0 ? (
        <View className="bg-destructive min-w-5 items-center rounded-full px-1.5 py-0.5">
          <Text className="text-xs font-semibold text-white">{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}
