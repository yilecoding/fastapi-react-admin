import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import {
  BellIcon,
  CheckCheckIcon,
  SendIcon,
  type LucideIcon,
  ChevronRightIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { BrandTop } from '@/components/brand-top'
import { Chevron, Group, GroupHeader, PressRow, Row, RowIcon } from '@/components/grouped'
import { NoticeRow } from '@/components/notice'
import { NoticeBanner } from '@/components/notice-banner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { noticesKey, useNoticeBanner, useNoticeFeed } from '@/lib/notices'
import { useUnread } from '@/lib/notifications'
import { usePerm } from '@/lib/perm'
import { useSession } from '@/lib/session'
import { relativeTime } from '@/lib/datetime'
import { useInbox, useWorkflowCounts, type InboxTab } from '@/lib/workflow'

/** 首页放几条公告。只是「最近有什么」，翻全部去通知屏的「全部」 */
const HOME_NOTICE_COUNT = 3
/** 首页放几条待办。复用收件箱「待办」那份缓存的第一页，不另起请求 */
const HOME_TODO_COUNT = 3

const WF_TILES: { tab: InboxTab; label: string; icon?: LucideIcon }[] = [
  { tab: 'todo', label: '待办' },
  { tab: 'done', label: '已办', icon: CheckCheckIcon },
  { tab: 'initiated', label: '我发起的', icon: SendIcon },
  { tab: 'cc', label: '抄送我的' },
]

export default function HomeScreen() {
  const { t } = useTranslation()
  const { user, reload } = useSession()
  const { unread, refresh: refreshUnread } = useUnread()
  const feed = useNoticeFeed(HOME_NOTICE_COUNT)
  const banner = useNoticeBanner()
  const qc = useQueryClient()
  // ⚠️ 只在**确实知道**有权限时才放这个入口。`known` 为假（权限码没问上）时
  // 不出现 —— 那一层的错误提示统一在「应用」那一屏兜住，首页不重复报一遍
  const { can, known: permKnown } = usePerm()
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)
  const todo = useInbox('todo')
  const wfCounts = useWorkflowCounts()
  const todoItems = (todo.data?.pages[0]?.items ?? []).slice(0, HOME_TODO_COUNT)

  async function onRefresh() {
    setRefreshing(true)
    try {
      // 公告那一组的失败有自己的错误块（下面），这里不用再管。
      // 弹窗也一起重拉（#190）：移动端没有 socket，「下拉一下看看有什么新的」是除了回前台之外唯一的触发点，
      // 新发了一条必须确认的，下拉之后当场弹出来（弹窗宿主挂在 `(app)/_layout.tsx`，它的查询一直有观察者）
      await Promise.all([
        reload(),
        refreshUnread(),
        feed.refetch(),
        banner.refetch(),
        qc.refetchQueries({ queryKey: noticesKey.popups }),
        todo.refetch(),
        wfCounts.refetch(),
      ])
    } catch {
      // 首页刷新失败不值得打断 —— 数据还是上一次那份，个人中心那屏有完整的错误态
    } finally {
      setRefreshing(false)
    }
  }

  const total = unread?.total ?? 0

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <BrandTop>
        <View className="gap-1 pt-1">
          <Text className="text-[13px] text-muted-foreground">{t(greeting())}</Text>
          {/* iOS 大标题 */}
          <Text className="text-3xl font-bold" style={{ letterSpacing: -0.9 }}>
            {user?.nickname || user?.username || ''}
          </Text>
        </View>
      </BrandTop>

      {/* 横幅（#190）：置顶 + 紧急 + 我没读。没有就整块不出 */}
      <NoticeBanner items={banner.data ?? []} />

      {/*
        公告（#186）：最近几条，置顶在前。三种状态必须长得不一样（硬纪律 9）——
        拉取失败如果渲染成「暂无公告」，读者会以为真的没有公告。
        ⚠️ 下拉刷新失败时**留着上一次的列表**，不换成错误块：内容还是能读的。
      */}
      <GroupHeader>{t('公告')}</GroupHeader>
      {feed.data ? (
        <Group>
          {feed.data.items.length === 0 ? (
            <Row first>
              <Text className="text-[14px] text-muted-foreground" testID="home-notice-empty">
                {t('暂无公告')}
              </Text>
            </Row>
          ) : (
            feed.data.items.map((n, i) => (
              <NoticeRow
                key={String(n.id)}
                notice={n}
                first={i === 0}
                // 🔴 ID 原样当字符串，不要 `Number()`（硬纪律 6）
                onPress={() =>
                  router.push({
                    pathname: '/notices/[id]',
                    params: { id: String(n.id) },
                  })
                }
              />
            ))
          )}
        </Group>
      ) : feed.isError ? (
        <View className="px-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('公告拉取失败')}</AlertTitle>
            <AlertDescription>{feed.error instanceof Error ? feed.error.message : String(feed.error)}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void feed.refetch()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : (
        <View className="gap-2 px-4">
          <Skeleton className="h-[52px] rounded-xl" />
          <Skeleton className="h-[52px] rounded-xl" />
        </View>
      )}

      {/*
        我的审批（#224）：四个收件箱的入口 + 前几条待办。审批不挂权限码（接口只要登录），所以人人可见。
        待办三种状态长得不一样（硬纪律 9）：失败给错误块 + 重试，不能塌成「没有待办」。
      */}
      <GroupHeader>{t('我的审批')}</GroupHeader>
      <View className="mx-4 flex-row rounded-xl bg-card py-3">
        {WF_TILES.map((x) => {
          const n = x.tab === 'todo' ? wfCounts.data?.todo : x.tab === 'cc' ? wfCounts.data?.cc_unread : undefined
          return (
            <Pressable
              key={x.tab}
              testID={`home-wf-${x.tab}`}
              onPress={() => router.push({ pathname: '/workflow', params: { tab: x.tab } })}
              className="flex-1 items-center gap-1 rounded-lg py-1 active:bg-muted"
            >
              {/* 已办 / 我发起的没有计数接口，给图标；硬塞「0」会被读成「一条都没有」 */}
              {x.icon ? (
                <View className="h-7 justify-center">
                  <Icon as={x.icon} className="size-5 text-muted-foreground" />
                </View>
              ) : (
                <Text className={`h-7 text-xl font-semibold ${n ? 'text-primary' : ''}`}>
                  {n === undefined ? '–' : n > 99 ? '99+' : n}
                </Text>
              )}
              <Text className="text-xs text-muted-foreground">{t(x.label)}</Text>
            </Pressable>
          )
        })}
      </View>

      <View className="flex-row items-end justify-between pr-8">
        <GroupHeader>{t('待办')}</GroupHeader>
        <Pressable onPress={() => router.push({ pathname: '/workflow', params: { tab: 'todo' } })} hitSlop={8}>
          <Text className="pb-1.5 text-[13px] text-primary">{t('查看全部')}</Text>
        </Pressable>
      </View>
      {todo.data ? (
        <Group>
          {todoItems.length === 0 ? (
            <Row first>
              <Text className="text-[14px] text-muted-foreground" testID="home-todo-empty">
                {t('没有待你审批的单子')}
              </Text>
            </Row>
          ) : (
            todoItems.map((r, i) => (
              <PressRow
                key={`${r.id}:${r.task_id ?? ''}`}
                first={i === 0}
                // 🔴 ID 原样当字符串（硬纪律 6）
                onPress={() =>
                  router.push({
                    pathname: '/workflow/[id]',
                    params: { id: r.id },
                  })
                }
              >
                <View className="flex-1 gap-0.5">
                  <View className="flex-row items-center gap-2">
                    <Text className="flex-1 text-[15px]" numberOfLines={1}>
                      {r.title}
                    </Text>
                    {r.urgent ? (
                      <Badge variant="destructive">
                        <Text>{t('加急')}</Text>
                      </Badge>
                    ) : null}
                  </View>
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    {[r.initiator_name, r.node_name, r.arrived_time ? relativeTime(r.arrived_time) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Chevron icon={ChevronRightIcon} />
              </PressRow>
            ))
          )}
        </Group>
      ) : todo.isError ? (
        <View className="px-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('审批单拉取失败')}</AlertTitle>
            <AlertDescription>{todo.error.message}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void todo.refetch()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : (
        <View className="gap-2 px-4">
          <Skeleton className="h-[56px] rounded-xl" />
          <Skeleton className="h-[56px] rounded-xl" />
        </View>
      )}

      <GroupHeader>{t('入口')}</GroupHeader>
      <Group>
        <PressRow first inset={56} onPress={() => router.push('/notifications')}>
          <RowIcon icon={BellIcon} />
          <Text className="flex-1 text-[15px]">{t('通知')}</Text>
          {/* 状态表达在**值**上，不动图标 —— 定稿那版就是这个规则 */}
          {total > 0 ? (
            <Text className="text-[13px] font-medium text-primary">{t('{{n}} 条未读', { n: total })}</Text>
          ) : (
            <Text className="text-[13px] text-muted-foreground">{t('没有未读')}</Text>
          )}
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
        <PressRow inset={56} onPress={() => router.push('/profile')}>
          <RowIcon icon={UserRoundIcon} />
          <Text className="flex-1 text-[15px]">{t('个人中心')}</Text>
          <Text className="text-[13px] text-muted-foreground">{t('资料 · 密码')}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
        {permKnown && can('sys:user:list') ? (
          <PressRow inset={56} onPress={() => router.push('/users')} testID="home-users">
            <RowIcon icon={UsersIcon} />
            <Text className="flex-1 text-[15px]">{t('用户')}</Text>
            <Text className="text-[13px] text-muted-foreground">{t('查看 · 搜索')}</Text>
            <Chevron icon={ChevronRightIcon} />
          </PressRow>
        ) : null}
      </Group>

      {/*
        这里原来有一块「待办与动态」的空态，文案是「等移动端要哪几个功能定下来
        再填这一块」。**那个前提已经变了**：这个仓库只做模板，不做某家公司的业务，
        所以「待办」永远不会有内容 —— 一块永久的空态比没有这块更糟
        （它长得像「加载失败」）。业务屏由下游按 `(tabs)/apps.tsx` 那张表往里加。
      */}
    </ScrollView>
  )
}

/**
 * 按本机时间问好。刻意不查服务端时区 —— 问候语说的是「你现在」，不是账号设定的时区。
 *
 * ⚠️ 返回的是 **key**，由调用处 `t()`。函数在模块级、拿不到 hook 的 `t`。
 */
function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}
