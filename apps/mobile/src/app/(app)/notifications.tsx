import { BellIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Group } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Text } from '@/components/ui/text'
import { api } from '@/lib/api'
import { NOTIFICATION_CATEGORY, type Notification } from '@/lib/contract'
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
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { refresh: refreshUnread, unread, known: unreadKnown } = useUnread()
  const [filter, setFilter] = React.useState<Filter>('all')

  /**
   * 🔴 **筛选条件进 query key，竞态就从结构上消失了。**
   *
   * 手写的版本是 `useEffect` + `useState` + 一个请求序号 ref：切页签会让两个
   * 请求同时在飞，**后到的赢**，而后到的不一定是当前页签的 ——
   * 表现是「选了未读、列表里却混着已读」，只在网络慢时出现，本机几乎复现不出来。
   * 序号 ref 能挡住，但那是每个列表屏都要自己再想一遍的东西。
   * key 里带 `filter` 之后，两个页签是**两份缓存**，没有互相覆盖这回事，
   * 而且切回去还是秒开。
   */
  const list = useQuery({
    queryKey: ['notifications', 'list', filter] as const,
    queryFn: () =>
      api.GET('/api/v1/sys/notifications', {
        /*
         * ⚠️ 查询参数走 `params.query`，**不要自己拼字符串** —— 拼的话参数名
         * 不会被校验（写成 `unreadd=true` 后端会静默忽略，界面上像筛选没生效）。
         *
         * 🔴 **也不要用条件展开** `...(cond ? { unread: true } : {})`：
         * 展开进来的属性**绕过 TS 的多余属性检查**，写错名字一样不报
         * （实测：`unreadd` 经展开是 0 错误，直接写是 1 错误）。
         * 该省的参数传 `undefined` —— openapi-fetch 的 querySerializer 会跳过它。
         */
        params: { query: { page: 1, size: 50, unread: filter === 'unread' ? true : undefined } },
      }),
  })

  const items = list.data?.items ?? null
  const error = list.error instanceof Error ? list.error.message : null

  async function onRefresh() {
    await Promise.all([list.refetch(), refreshUnread()])
  }

  async function markRead(n: Notification) {
    if (n.read_time) return
    // 乐观更新：这个接口是幂等的（重复标记返回 0 行也算成功），
    // 失败了也不用手工回滚 —— 下面 onSettled 里的 invalidate 会纠正
    qc.setQueryData(['notifications', 'list', filter] as const, (prev: typeof list.data) =>
      prev
        ? { ...prev, items: prev.items.map((x) => (x.id === n.id ? { ...x, read_time: new Date().toISOString() } : x)) }
        : prev,
    )
    try {
      // 路径参数走 `params.path`：第一个参数是 **schema 里的模板** `{pk}`，
      // 不是拼好的串 —— 这样路径写错就是编译错误
      await api.PUT('/api/v1/sys/notifications/{pk}/read', { params: { path: { pk: n.id } } })
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['notifications', 'list'] }),
        refreshUnread(),
      ])
    }
  }

  const markAll = useMutation({
    mutationFn: () => api.PUT('/api/v1/sys/notifications/read-all'),
    onSettled: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['notifications'] })])
    },
  })

  const total = unread?.total ?? 0
  /*
   * 🔴 **只在「确实知道是 0」的时候禁用。**
   *
   * 曾经写的是 `disabled={total === 0}`，而 `total` 是 `unread?.total ?? 0` ——
   * 未读数那个请求失败时它是 0，于是按钮**永久禁用**，界面上没有任何理由，
   * 看起来像「这个功能不存在」（硬纪律 9）。`known`（= query 的 `isSuccess`）
   * 为假时放开：接口本身是幂等的，点了最多是白点一次。
   */
  const canMarkAll = !markAll.isPending && (!unreadKnown || total > 0)

  return (
    <View className="bg-background flex-1">
      <View className="flex-row items-center gap-3 px-4 pt-3 pb-1">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="flex-1">
          <TabsList className="flex-row">
            <TabsTrigger value="all" className="flex-1">
              <Text>{t('全部')}</Text>
            </TabsTrigger>
            <TabsTrigger value="unread" className="flex-1">
              <Text>{total > 0 ? t('未读 {{n}}', { n: total }) : t('未读')}</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" variant="ghost" disabled={!canMarkAll} onPress={() => markAll.mutate()}>
          {markAll.isPending ? <ActivityIndicator size="small" /> : null}
          <Text>{t('全部已读')}</Text>
        </Button>
      </View>

      <ScrollView
        contentContainerClassName="gap-3 px-4 pb-10 pt-3"
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void onRefresh()} />}
      >
        {/* 硬纪律 9：失败必须是**可见状态**，不是缺失状态 —— 不能让「拉取失败」
            和「一条通知都没有」长得一样 */}
        {error ? (
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('通知拉取失败')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void list.refetch()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        ) : items === null ? (
          <View className="gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </View>
        ) : items.length === 0 ? (
          <Group className="mx-0 items-center gap-2 py-10">
              <Icon as={BellIcon} className="text-muted-foreground size-8" />
              <Text variant="small" className="text-muted-foreground">
                {t(filter === 'unread' ? '没有未读通知' : '还没有通知')}
              </Text>
              <Text className="text-muted-foreground text-center text-xs">
                {t(filter === 'unread' ? '所有通知都读过了' : '有新消息时会出现在这里')}
              </Text>
          </Group>
        ) : (
          <Group className="mx-0">
            {items.map((n, i) => (
              <NotifRow key={n.id} n={n} first={i === 0} onPress={() => void markRead(n)} />
            ))}
          </Group>
        )}
      </ScrollView>
    </View>
  )
}

function NotifRow({ n, first, onPress }: { n: Notification; first?: boolean; onPress: () => void }) {
  const { t } = useTranslation()
  const unread = !n.read_time
  return (
    <>
      {first ? null : <View className="bg-border ml-5 h-px" />}
      <Pressable onPress={onPress} className="active:bg-muted gap-1.5 px-5 py-3.5">
        <View className="flex-row items-center gap-2">
          {/* 未读只用一枚主色圆点 —— 不要把分类标签染成主色，
              那是「状态」和「分类」两回事混在一起 */}
          {unread ? <View className="bg-primary h-1.5 w-1.5 rounded-full" /> : null}
          <Text className="text-muted-foreground text-[11px]">
            {t(NOTIFICATION_CATEGORY[n.category] ?? '通知')}
          </Text>
          <View className="flex-1" />
          <Text className="text-muted-foreground font-mono text-[11px]">{relativeTime(n.created_time)}</Text>
        </View>
        <Text className={`text-[15px] ${unread ? 'font-semibold' : ''}`}>{n.title}</Text>
        <Text variant="small" className="text-muted-foreground leading-5" numberOfLines={2}>
          {n.content}
        </Text>
      </Pressable>
    </>
  )
}
