
import * as React from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Rail } from '@/components/rail'
import { Text } from '@/components/ui/text'
import { api } from '@/lib/api'
import { NOTIFICATION_CATEGORY, type Notification, type PageData } from '@/lib/contract'
import { relativeTime } from '@/lib/datetime'
import { useUnread } from '@/lib/notifications'

type Filter = 'all' | 'unread'

/**
 * 通知列表。
 *
 * 🔴 **不用表格、不做分页器。** 这是移动端和 web 端分道的地方（issue #39 第 1 条
 * 拍 C 路线的判据就是这个）—— 这里是「一条条卡片 + 下拉刷新 + 触底加载」。
 */
export default function NotificationsScreen() {
  const { refresh: refreshUnread, unread } = useUnread()
  const [filter, setFilter] = React.useState<Filter>('all')
  const [items, setItems] = React.useState<Notification[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [marking, setMarking] = React.useState(false)

  const load = React.useCallback(async (f: Filter) => {
    setError(null)
    try {
      const q = f === 'unread' ? '&unread=true' : ''
      const page = await api.GET<PageData<Notification>>(`/api/v1/sys/notifications?page=1&size=50${q}`)
      setItems(page.items)
    } catch (err) {
      setItems(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  React.useEffect(() => {
    void load(filter)
  }, [filter, load])

  async function onRefresh() {
    setRefreshing(true)
    await load(filter)
    await refreshUnread()
    setRefreshing(false)
  }

  async function markRead(n: Notification) {
    if (n.read_time) return
    // 乐观更新：这个接口是幂等的（重复标记返回 0 行也算成功），
    // 所以失败了也不用回滚到「未读」——下一次刷新自然会纠正。
    setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, read_time: new Date().toISOString() } : x)) ?? null)
    try {
      await api.PUT(`/api/v1/sys/notifications/${n.id}/read`)
      await refreshUnread()
    } catch {
      void load(filter)
    }
  }

  async function markAll() {
    setMarking(true)
    try {
      await api.PUT('/api/v1/sys/notifications/read-all')
      await load(filter)
      await refreshUnread()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMarking(false)
    }
  }

  const total = unread?.total ?? 0

  return (
    <View className="bg-panel flex-1">
      <View className="border-line flex-row items-center gap-2 border-b px-6 py-2.5">
        <Chip label="全部" active={filter === 'all'} onPress={() => setFilter('all')} />
        <Text className="text-line">/</Text>
        <Chip label={total > 0 ? `未读 ${total}` : '未读'} active={filter === 'unread'} onPress={() => setFilter('unread')} />
        <View className="flex-1" />
        <Button size="sm" variant="ghost" disabled={total === 0 || marking} onPress={() => void markAll()}>
          {marking ? <ActivityIndicator size="small" /> : null}
          <Text>全部已读</Text>
        </Button>
      </View>

      <ScrollView
        contentContainerClassName="px-6 pb-12 pt-1"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        {/* 硬纪律 9：失败必须是**可见状态**，不是缺失状态 —— 不能让「拉取失败」
            和「一条通知都没有」长得一样 */}
        {error ? (
          <View className="border-destructive/40 bg-destructive/10 mt-4 gap-2 rounded-md border p-3.5">
            <Text className="text-ink text-sm">通知拉取失败：{error}</Text>
            <Button size="sm" variant="outline" onPress={() => void load(filter)}>
              <Text>重试</Text>
            </Button>
          </View>
        ) : items === null ? (
          <View className="items-center py-20">
            <ActivityIndicator />
          </View>
        ) : items.length === 0 ? (
          <View className="py-20">
            <Text className="text-dim text-center text-sm">
              {filter === 'unread' ? '没有未读通知' : '还没有通知'}
            </Text>
            <Text className="text-faint mt-1.5 text-center text-xs">
              {filter === 'unread' ? '所有通知都读过了' : '有新消息时会出现在这里'}
            </Text>
          </View>
        ) : (
          <Rail className="mt-4">
            {items.map((n) => (
              <Row key={n.id} n={n} onPress={() => void markRead(n)} />
            ))}
          </Rail>
        )}
      </ScrollView>
    </View>
  )
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="py-1"
    >
      <Text
        className={`font-mono text-[11px] ${active ? 'text-ink' : 'text-faint'}`}
        style={{ letterSpacing: 1.4, textDecorationLine: active ? 'underline' : 'none' }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * 一条通知挂在导轨上。未读那枚刻度是主色实心 —— 和权限链上的节点同一套语汇。
 */
function Row({ n, onPress }: { n: Notification; onPress: () => void }) {
  const unread = !n.read_time
  return (
    <Pressable onPress={onPress} className="active:bg-node border-line gap-1.5 border-b py-3.5">
      {/* 刻度：把这条钉在导轨上 */}
      <View
        pointerEvents="none"
        className={unread ? 'bg-accent' : 'bg-line'}
        style={{ position: 'absolute', left: -15, top: 22, width: 9, height: unread ? 2 : 1 }}
      />
      <View className="flex-row items-center gap-2">
        <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 1.4 }}>
          {(NOTIFICATION_CATEGORY[n.category] ?? '通知').toUpperCase()}
        </Text>
        <View className="flex-1" />
        <Text className="text-faint font-mono text-[10px]">{relativeTime(n.created_time)}</Text>
      </View>
      <Text className={`text-ink text-[15px] ${unread ? 'font-semibold' : ''}`}>{n.title}</Text>
      <Text className="text-dim text-[13px] leading-5" numberOfLines={2}>
        {n.content}
      </Text>
    </Pressable>
  )
}
