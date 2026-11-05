import { useLocalSearchParams, useRouter } from 'expo-router'
import { FileCheckIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Text } from '@/components/ui/text'
import { relativeTime } from '@/lib/datetime'
import { StatusBadge } from '@/components/workflow'
import { useInbox, useWorkflowCounts, type InboxTab, type InstanceRow } from '@/lib/workflow'

/**
 * 审批收件箱（#224 2a）：待办 · 已办 · 我发起的 · 抄送我的。
 *
 * 当前 tab 写在路由参数里（`?tab=cc`）：「应用」宫格 / 通知可以直接定位到某个 tab，
 * 而且从详情返回时 tab 还在（参数跟着这一屏走）。
 *
 * 四个 tab 各是一份 `useInfiniteQuery` 缓存（key 里带 tab），切回去秒开、互不串页。
 */
const TABS: { value: InboxTab; label: string; empty: string }[] = [
  { value: 'todo', label: '待办', empty: '没有待你审批的单子' },
  { value: 'done', label: '已办', empty: '你还没审批过单子' },
  { value: 'initiated', label: '我发起的', empty: '你还没发起过审批' },
  { value: 'cc', label: '抄送我的', empty: '没有抄送给你的单子' },
]

function isTab(v: unknown): v is InboxTab {
  return TABS.some((x) => x.value === v)
}

export default function WorkflowInboxScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const params = useLocalSearchParams<{ tab?: string }>()
  const tab: InboxTab = isTab(params.tab) ? params.tab : 'todo'
  const q = useInbox(tab)
  const counts = useWorkflowCounts()

  const items = q.data ? q.data.pages.flatMap((p) => p.items) : null
  // 首屏失败占住整块（硬纪律 9）；翻页失败只挂在底部，已经加载的照常显示
  const firstPageError = !q.data && q.error ? q.error.message : null
  const nextPageError = q.data && q.isFetchNextPageError ? (q.error?.message ?? null) : null

  async function onPullRefresh() {
    await Promise.all([q.refetch(), counts.refetch()])
  }

  const badge = (v: InboxTab) => (v === 'todo' ? counts.data?.todo : v === 'cc' ? counts.data?.cc_unread : 0) ?? 0

  return (
    <View className="bg-background flex-1">
      <View className="px-4 pt-3 pb-2">
        <Tabs value={tab} onValueChange={(v) => router.setParams({ tab: v })}>
          <TabsList className="flex-row">
            {TABS.map((x) => (
              <TabsTrigger key={x.value} value={x.value} className="flex-1 px-1" testID={`wf-tab-${x.value}`}>
                <Text numberOfLines={1}>{t(x.label)}</Text>
                {badge(x.value) > 0 ? (
                  <View className="bg-destructive ml-1 min-w-[16px] items-center rounded-full px-1">
                    <Text className="text-[10px] font-semibold leading-4 text-white">
                      {badge(x.value) > 99 ? '99+' : badge(x.value)}
                    </Text>
                  </View>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </View>

      {firstPageError ? (
        <View className="p-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('审批单拉取失败')}</AlertTitle>
            <AlertDescription>{firstPageError}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void q.refetch()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : items === null ? (
        <View className="gap-2.5 px-4 pt-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[84px] rounded-xl" />
          ))}
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => `${r.id}:${r.task_id ?? r.cc_id ?? ''}`}
          contentContainerClassName="gap-2.5 px-4 pt-1 pb-10"
          refreshControl={
            <RefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => void onPullRefresh()} />
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage()
          }}
          ListEmptyComponent={
            <View className="items-center gap-2 py-16">
              <Icon as={FileCheckIcon} className="text-muted-foreground size-8" />
              <Text className="text-muted-foreground text-sm">{t(TABS.find((x) => x.value === tab)!.empty)}</Text>
            </View>
          }
          ListFooterComponent={
            nextPageError ? (
              <View className="items-center gap-2 pt-4">
                <Text className="text-destructive text-xs">{t('加载更多失败')}</Text>
                <Button variant="outline" size="sm" onPress={() => void q.fetchNextPage()}>
                  <Text>{t('重试')}</Text>
                </Button>
              </View>
            ) : q.isFetchingNextPage ? (
              <View className="items-center pt-4">
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <InboxRow
              row={item}
              tab={tab}
              onPress={() =>
                router.push({ pathname: '/workflow/[id]', params: { id: item.id } })
              }
            />
          )}
        />
      )}
    </View>
  )
}

function InboxRow({ row, tab, onPress }: { row: InstanceRow; tab: InboxTab; onPress: () => void }) {
  const { t } = useTranslation()
  // 每个 tab 关心的时间不同：待办看「什么时候到我这」，已办看「我什么时候处理的」，抄送看「什么时候抄给我」
  const at =
    tab === 'todo' ? row.arrived_time : tab === 'done' ? row.handled_time : tab === 'cc' ? row.cc_time : row.created_time
  const unreadCc = tab === 'cc' && !row.read_time

  return (
    // `active:` 只在 Pressable 上生效（见 users/index.tsx 的注释），所以按下态挂在这一层
    <Pressable
      onPress={onPress}
      testID={`wf-row-${row.id}`}
      className="bg-card active:bg-muted gap-1.5 rounded-xl px-4 py-3"
    >
      <View className="flex-row items-center gap-2">
        {unreadCc ? <View className="bg-primary size-2 rounded-full" /> : null}
        <Text className="flex-1 text-[15px] font-medium" numberOfLines={1}>
          {row.title}
        </Text>
        {row.urgent ? (
          <Badge variant="destructive">
            <Text>{t('加急')}</Text>
          </Badge>
        ) : null}
        {/* 待办都是「审批中」，挂个徽标是噪音；其余三个 tab 才显示状态 */}
        {tab !== 'todo' ? <StatusBadge status={row.status} /> : null}
      </View>
      {row.summary ? (
        <Text className="text-muted-foreground text-[13px] leading-5" numberOfLines={2}>
          {row.summary}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-1">
        <Text className="text-muted-foreground/80 flex-1 text-xs" numberOfLines={1}>
          {[row.initiator_name, row.definition_name, tab === 'todo' ? row.node_name : null].filter(Boolean).join(' · ')}
        </Text>
        {at ? <Text className="text-muted-foreground/80 text-xs">{relativeTime(at)}</Text> : null}
      </View>
    </Pressable>
  )
}
