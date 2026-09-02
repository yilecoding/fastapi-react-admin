import { useRouter } from 'expo-router'
import { BellIcon, ChevronRightIcon, UserRoundIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCSSVariable } from 'uniwind'

import { TenonMark } from '@/components/tenon-mark'
import { Card, Divider, Section } from '@/components/ui/panel'
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
      contentContainerStyle={{ paddingTop: insets.top + 12 }}
      contentContainerClassName="gap-6 px-4 pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      {/* 顶部只有一行极轻的标识 —— 品牌在登录页已经讲过了，进来之后不该再抢注意力 */}
      <View className="flex-row items-center gap-2 px-1 pt-1">
        <TenonMark size={14} color={faint} />
        <Text className="text-faint font-mono text-[11px]" style={{ letterSpacing: 0.5 }}>
          {BRAND.wordmark}
        </Text>
      </View>

      <View className="px-1">
        <Text className="text-faint text-sm">{greeting()}</Text>
        <Text className="text-ink mt-1 text-[27px] font-semibold" style={{ letterSpacing: -0.8 }}>
          {user?.nickname || user?.username || ''}
        </Text>
        <Text className="text-dim mt-1.5 text-sm">
          {[user?.dept, user?.roles.join('、')].filter(Boolean).join('  ·  ') || '暂无部门与角色'}
        </Text>
      </View>

      <Card>
        <View className="flex-row py-3.5">
          <Fact label="账号" value={accountKind(user)} />
          <View className="bg-line w-px" />
          <Fact label="时区" value={shortZone(user?.timezone)} />
          <View className="bg-line w-px" />
          <Fact label="未读" value={String(total)} accent={total > 0} />
        </View>
      </Card>

      <Section label="快捷入口">
        <Entry
          icon={BellIcon}
          title="通知"
          meta={total > 0 ? `${total} 条未读` : '没有未读'}
          dot={total > 0}
          onPress={() => router.push('/notifications')}
        />
        <Entry
          icon={UserRoundIcon}
          title="个人中心"
          meta="资料 · 密码 · 登出"
          onPress={() => router.push('/profile')}
          last
        />
      </Section>

      <Section label="动态">
        {/* 空态要说清楚是「还没做」，不能长得像「加载失败」或「没有数据」——
            三者在用户眼里都是一片空，分不清的第一反应是「这 App 坏了」 */}
        <View className="items-center gap-1.5 px-6 py-9">
          <Text className="text-dim text-sm">还没有待办和动态</Text>
          <Text className="text-faint text-center text-xs leading-5">
            等移动端要哪几个功能定下来再填这一屏
          </Text>
        </View>
      </Section>
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

function accountKind(user: { is_superuser: boolean; is_staff: boolean } | null) {
  if (!user) return '—'
  return user.is_superuser ? '超管' : user.is_staff ? '管理员' : '普通'
}

/** `Asia/Shanghai` → `Shanghai`。三格并排放不下全称，而前缀是冗余的 */
function shortZone(tz?: string) {
  if (!tz) return '—'
  return tz.split('/').pop() ?? tz
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View className="flex-1 items-center gap-1">
      <Text className="text-faint text-xs">{label}</Text>
      <Text className={`text-[15px] font-medium ${accent ? 'text-accent' : 'text-ink'}`} numberOfLines={1}>
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
  last,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  title: string
  meta: string
  onPress?: () => void
  dot?: boolean
  last?: boolean
}) {
  return (
    <>
      <Pressable onPress={onPress} className="active:bg-panel min-h-[52px] flex-row items-center gap-3 px-4 py-3">
        <Icon as={icon} className="text-faint size-4" />
        <Text className="text-ink flex-1 text-[15px]">{title}</Text>
        {dot ? <View className="bg-accent h-1.5 w-1.5 rounded-full" /> : null}
        <Text className="text-faint text-[13px]">{meta}</Text>
        <Icon as={ChevronRightIcon} className="text-faint size-4" />
      </Pressable>
      {last ? null : <Divider />}
    </>
  )
}
