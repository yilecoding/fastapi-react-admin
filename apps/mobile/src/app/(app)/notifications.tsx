import { BellIcon, TriangleAlertIcon } from 'lucide-react-native'
import * as React from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
 * 拍 C 路线的判据就是这个）—— 这里是「一条条 + 下拉刷新」。
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
    // 失败了也不用回滚到「未读」—— 下一次刷新自然会纠正
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
    <View className="bg-background flex-1">
      <View className="flex-row items-center gap-3 px-4 py-3">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="flex-1">
          <TabsList className="flex-row">
            <TabsTrigger value="all" className="flex-1">
              <Text>全部</Text>
            </TabsTrigger>
            <TabsTrigger value="unread" className="flex-1">
              <Text>{total > 0 ? `未读 ${total}` : '未读'}</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" variant="ghost" disabled={total === 0 || marking} onPress={() => void markAll()}>
          {marking ? <ActivityIndicator size="small" /> : null}
          <Text>全部已读</Text>
        </Button>
      </View>

      <ScrollView
        contentContainerClassName="gap-3 px-4 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        {/* 硬纪律 9：失败必须是**可见状态**，不是缺失状态 —— 不能让「拉取失败」
            和「一条通知都没有」长得一样 */}
        {error ? (
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>通知拉取失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void load(filter)} className="mt-2 self-start">
              <Text>重试</Text>
            </Button>
          </Alert>
        ) : items === null ? (
          <View className="gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </View>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="items-center gap-2 py-10">
              <Icon as={BellIcon} className="text-muted-foreground size-8" />
              <Text variant="small" className="text-muted-foreground">
                {filter === 'unread' ? '没有未读通知' : '还没有通知'}
              </Text>
              <Text className="text-muted-foreground text-center text-xs">
                {filter === 'unread' ? '所有通知都读过了' : '有新消息时会出现在这里'}
              </Text>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="gap-0 px-0">
              {items.map((n, i) => (
                <Row key={n.id} n={n} first={i === 0} onPress={() => void markRead(n)} />
              ))}
            </CardContent>
          </Card>
        )}
      </ScrollView>
    </View>
  )
}

function Row({ n, first, onPress }: { n: Notification; first?: boolean; onPress: () => void }) {
  const unread = !n.read_time
  return (
    <>
      {first ? null : <Separator className="my-0" />}
      <Pressable onPress={onPress} className="active:bg-accent gap-1.5 px-6 py-3.5">
        <View className="flex-row items-center gap-2">
          <Badge variant={unread ? 'default' : 'secondary'}>
            <Text>{NOTIFICATION_CATEGORY[n.category] ?? '通知'}</Text>
          </Badge>
          <View className="flex-1" />
          <Text className="text-muted-foreground font-mono text-[11px]">{relativeTime(n.created_time)}</Text>
        </View>
        <Text className={`text-sm ${unread ? 'font-semibold' : ''}`}>{n.title}</Text>
        <Text variant="small" className="text-muted-foreground leading-5" numberOfLines={2}>
          {n.content}
        </Text>
      </Pressable>
    </>
  )
}
