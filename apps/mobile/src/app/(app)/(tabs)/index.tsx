import { useRouter } from 'expo-router'
import { BellIcon, ChevronRightIcon, UserRoundIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BrandBackdrop } from '@/components/brand-backdrop'
import { TenonMark } from '@/components/tenon-mark'
import { Icon } from '@/components/ui/icon'
import { Eyebrow, Rule, SectionHead } from '@/components/ui/panel'
import { Text } from '@/components/ui/text'
import { useCSSVariable } from 'uniwind'

import { BRAND } from '@/lib/brand'
import { useUnread } from '@/lib/notifications'
import { useSession } from '@/lib/session'

export default function HomeScreen() {
  const { user, reload } = useSession()
  const { unread, refresh: refreshUnread } = useUnread()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)
  const inkVar = useCSSVariable('--color-ink')
  const ink = typeof inkVar === 'string' ? inkVar : '#111'

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
    <View className="bg-panel flex-1">
      {/* 底纹只铺在上半屏：往下是内容区，格子会抢注意力 */}
      <BrandBackdrop className="absolute top-0 right-0 left-0 h-80" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 16 }}
        contentContainerClassName="px-5 pb-12 gap-8"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <View className="gap-6">
          <View className="flex-row items-center gap-2.5">
            <TenonMark size={18} color={ink} />
            <Text className="text-ink font-mono text-[11px]" style={{ letterSpacing: 0.6 }}>
              {BRAND.wordmark}
            </Text>
          </View>

          <View>
            <Eyebrow>{greetingEyebrow()}</Eyebrow>
            <Text
              className="text-ink mt-3 text-[26px] font-semibold"
              style={{ letterSpacing: -0.7, lineHeight: 34 }}
            >
              {user?.nickname || user?.username || ''}
            </Text>
            <Text className="text-dim mt-1.5 text-sm">
              {[user?.dept, user?.roles.join('、')].filter(Boolean).join('  ·  ') || '暂无部门与角色'}
            </Text>
          </View>
        </View>

        {/* 一条导轨，三格数据钉在上面 —— web 面板里那条 rail 的压缩版 */}
        <View className="gap-3">
          <Rule />
          <View className="flex-row">
            <Fact label="账号" value={accountKind(user)} />
            <Fact label="时区" value={user?.timezone ?? '—'} />
            <Fact label="未读" value={String(unread?.total ?? 0)} accent={(unread?.total ?? 0) > 0} />
          </View>
        </View>

        <View className="gap-3">
          <SectionHead label="ENTRIES" />
          <View>
            <Entry
              icon={BellIcon}
              title="通知"
              meta={unread && unread.total > 0 ? `${unread.total} 条未读` : '没有未读'}
              dot={(unread?.total ?? 0) > 0}
              onPress={() => router.push('/notifications')}
            />
            <Entry icon={UserRoundIcon} title="个人中心" meta="资料 · 密码 · 登出" onPress={() => router.push('/profile')} />
          </View>
        </View>

        <View className="gap-3">
          <SectionHead label="ACTIVITY" />
          <View className="py-8">
            <Text className="text-faint text-center text-sm">还没有待办和动态</Text>
            <Text className="text-faint mt-1.5 text-center text-xs">
              这一屏等移动端要哪几个功能定下来再填
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

/** 按本机时间问好。刻意不查服务端时区 —— 问候语说的是「你现在」，不是账号设定的时区 */
function greetingEyebrow() {
  const h = new Date().getHours()
  if (h < 6) return '深夜'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function accountKind(user: { is_superuser: boolean; is_staff: boolean } | null) {
  if (!user) return '—'
  return user.is_superuser ? '超管' : user.is_staff ? '管理员' : '普通'
}

/** 钉在导轨上的一格：等宽小标签在上、值在下，左边一竖是刻度 */
function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View className="border-line flex-1 border-l pl-3 first:border-l-0 first:pl-0">
      <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 1.6 }}>
        {label}
      </Text>
      <Text
        className={`mt-1.5 text-base font-medium ${accent ? 'text-accent' : 'text-ink'}`}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  )
}

function Entry({
  icon,
  title,
  meta,
  onPress,
  dot,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  title: string
  meta: string
  onPress?: () => void
  dot?: boolean
}) {
  return (
    <Pressable onPress={onPress} className="active:bg-node border-line flex-row items-center gap-3 border-b py-3.5">
      <Icon as={icon} className="text-faint size-4" />
      <Text className="text-ink flex-1 text-sm">{title}</Text>
      {dot ? <View className="bg-accent h-1.5 w-1.5 rounded-full" /> : null}
      <Text className="text-faint font-mono text-[11px]">{meta}</Text>
      <Icon as={ChevronRightIcon} className="text-faint size-3.5" />
    </Pressable>
  )
}
