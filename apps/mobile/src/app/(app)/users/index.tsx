import { useRouter } from 'expo-router'
import { ChevronRightIcon, SearchIcon, TriangleAlertIcon, UsersIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import type { UserListItem } from '@/lib/contract'
import { useDebounced } from '@/lib/debounce'
import { useUsers, type UserFilter } from '@/lib/users'

type StatusFilter = 'all' | 'on' | 'off'

/**
 * 用户列表 —— **移动端「分页列表」的范式样板**。
 *
 * 通知那一屏是 `size: 50` 一次拉完 + `ScrollView` + `map()`，那个形状在
 * 几十条以内看不出问题，上千条就废了。这一屏是要被抄的那一份：
 * `useInfiniteQuery` + `FlatList` + 防抖搜索 + 五个状态。
 *
 * ## 🔴 五个状态，缺一个都会变成「这 App 坏了」
 *
 * | 状态 | 长什么样 | 为什么不能省 |
 * |---|---|---|
 * | 首屏加载 | 骨架屏 | —— |
 * | **首屏失败** | 占位的错误块 + 重试 | 硬纪律 9。不能和「一条都没有」长得一样 |
 * | 空（没筛选） | 「还没有用户」 | —— |
 * | 空（筛了） | 「没有匹配」+ 提示改条件 | 和上一条**必须分开**：用户筛出空白时第一反应是「搜坏了」 |
 * | **翻页失败** | 列表底部一条错误 + 重试 | ⚠️ 这一条最容易漏 —— 前面的数据是好的，**不能**把整屏换成错误块，那等于把已经拿到的内容丢了 |
 *
 * ## ⚠️ 为什么每条是一张独立的卡，而不是 iOS 那种「一整块分组」
 *
 * `components/grouped.tsx` 的 `Group` 是一个 `Card` 包住所有行、行间画内缩
 * 分隔线。那个形状**和虚拟化冲突**：`FlatList` 只挂载可见的那几行，
 * 包不住一个跨全表的圆角容器（滚动时上下边缘的圆角会跟着行进出而闪）。
 * 定长列表（设置屏那种）继续用 `Group`；**要翻页的列表用独立卡片**。
 */
export default function UsersScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const [keyword, setKeyword] = React.useState('')
  const [status, setStatus] = React.useState<StatusFilter>('all')

  // 🔴 输入框显示未延后的 `keyword`，进 query key 的是延后的那个（见 `lib/debounce.ts`）
  const debounced = useDebounced(keyword)
  const filter = React.useMemo<UserFilter>(
    () => ({ username: debounced, status: status === 'all' ? undefined : status === 'on' ? 1 : 0 }),
    [debounced, status],
  )

  const q = useUsers(filter)
  // `pages` 是每一页的 PageData，摊平成一条条
  const items = React.useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? null, [q.data])
  const total = q.data?.pages[0]?.total ?? 0
  const filtering = debounced.trim() !== '' || status !== 'all'
  const firstPageError = q.isError && items === null ? errText(q.error) : null
  /*
   * ⚠️ 「翻页失败」用 **`isFetchNextPageError`**，不要用 `isError && items !== null`。
   * 后者会把**下拉刷新失败**也算进来 —— 于是列表底部冒出一句「加载更多失败」，
   * 而用户刚做的动作是下拉。文案指着一个他没做过的操作，比不报还难懂。
   * TanStack Query v5 把这两件事分开了（`isFetchNextPageError`）。
   */
  const nextPageError = q.isFetchNextPageError ? errText(q.error) : null

  /*
   * 🔴 下拉刷新失败必须说一声（硬纪律 9）。它是这一屏唯一**没有位置可占**的失败：
   * 列表内容还在（那是上一次的数据、仍然可读），把整屏换成错误块反而丢内容。
   * 所以走 toast —— 和「写操作失败走 toast」同一条理由（见 `ui/toast.tsx`）。
   * 不报的话下拉一下什么都没变，看起来像「刷新了但没有新数据」。
   */
  async function onPullRefresh() {
    const r = await q.refetch()
    if (r.isError) toast.error(t('刷新失败'), { description: errText(r.error) })
  }

  return (
    <View className="bg-background flex-1">
      <View className="gap-2.5 px-4 pt-3 pb-2">
        <View className="relative justify-center">
          <Icon as={SearchIcon} className="text-muted-foreground absolute left-3 z-10 size-4" />
          <Input
            value={keyword}
            onChangeText={setKeyword}
            placeholder={t('搜索用户名')}
            autoCapitalize="none"
            autoCorrect={false}
            testID="users-search"
            className="h-11 rounded-xl ps-9"
          />
        </View>
        <View className="flex-row items-center gap-3">
          <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)} className="flex-1">
            <TabsList className="flex-row">
              <TabsTrigger value="all" className="flex-1">
                <Text>{t('全部')}</Text>
              </TabsTrigger>
              <TabsTrigger value="on" className="flex-1">
                <Text>{t('启用')}</Text>
              </TabsTrigger>
              <TabsTrigger value="off" className="flex-1">
                <Text>{t('停用')}</Text>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {/* 总数只在真的知道时显示 —— 拉失败时 `?? 0` 会让它显示「共 0 人」，
              那是一个看起来像结论的假数字 */}
          {/* 占位期间转个圈：屏上还是旧结果，不给信号的话看起来像「搜了但没反应」 */}
          {q.isPlaceholderData && q.isFetching ? (
            <ActivityIndicator size="small" />
          ) : items !== null ? (
            <Text className="text-muted-foreground shrink-0 text-xs" testID="users-total">
              {t('共 {{n}} 人', { n: total })}
            </Text>
          ) : null}
        </View>
      </View>

      {firstPageError ? (
        <View className="p-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('用户拉取失败')}</AlertTitle>
            <AlertDescription>{firstPageError}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void q.refetch()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : items === null ? (
        <View className="gap-3 px-4 pt-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[74px] rounded-xl" />
          ))}
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(u) => String(u.id)}
          contentContainerClassName="gap-2.5 px-4 pt-1 pb-10"
          refreshControl={
            <RefreshControl
              refreshing={q.isRefetching && !q.isFetchingNextPage}
              onRefresh={() => void onPullRefresh()}
            />
          }
          /*
           * 🔴 `onEndReachedThreshold` 的单位是**屏高的倍数**，不是像素。
           * 0.5 = 还差半屏就开始拉下一页，翻到底时几乎看不到等待。
           *
           * ⚠️ 必须挡住重复触发：`onEndReached` 在一次滚动里会被调多次，
           * 不看 `hasNextPage` / `isFetchingNextPage` 就会连发好几页
           * （TanStack Query 会去重同一个 pageParam，但 `fetchNextPage` 期间
           * 页码已经推进，仍然可能跳页）。
           */
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            // 🔴 占位期间（`isPlaceholderData`）显示的是**上一套筛选条件**的数据，
            // 此时 `hasNextPage` / 页码都属于旧的那一套 —— 翻页会把两套结果串起来
            if (q.hasNextPage && !q.isFetchingNextPage && !q.isPlaceholderData) void q.fetchNextPage()
          }}
          ListEmptyComponent={
            <Card className="items-center gap-2 rounded-xl border-0 py-12 shadow-none">
              <Icon as={UsersIcon} className="text-muted-foreground size-8" />
              <Text variant="small" className="text-muted-foreground">
                {t(filtering ? '没有匹配的用户' : '还没有用户')}
              </Text>
              <Text className="text-muted-foreground/70 px-8 text-center text-xs leading-5">
                {t(filtering ? '换个关键词，或把筛选切回「全部」' : '后台创建的用户会出现在这里')}
              </Text>
            </Card>
          }
          ListFooterComponent={
            <ListFooter
              error={nextPageError}
              loading={q.isFetchingNextPage}
              hasMore={q.hasNextPage}
              count={items.length}
              onRetry={() => void q.fetchNextPage()}
            />
          }
          renderItem={({ item }) => (
            <UserRow
              user={item}
              onPress={() => router.push({ pathname: '/users/[id]', params: { id: String(item.id) } })}
            />
          )}
        />
      )}
    </View>
  )
}

function ListFooter({
  error,
  loading,
  hasMore,
  count,
  onRetry,
}: {
  error: string | null
  loading: boolean
  hasMore: boolean
  count: number
  onRetry: () => void
}) {
  const { t } = useTranslation()

  if (error) {
    return (
      <View className="items-center gap-2 pt-4">
        <Text className="text-destructive text-xs">{t('加载更多失败')}</Text>
        <Button variant="outline" size="sm" onPress={onRetry}>
          <Text>{t('重试')}</Text>
        </Button>
      </View>
    )
  }
  if (loading) {
    return (
      <View className="items-center pt-4">
        <ActivityIndicator size="small" />
      </View>
    )
  }
  // 只有真的翻过页才说「没有更多了」——一屏就装完的时候这句是噪音
  if (!hasMore && count > 0) {
    return (
      <Text className="text-muted-foreground/70 pt-4 text-center text-xs">{t('没有更多了')}</Text>
    )
  }
  return null
}

/**
 * 🔴 **props 的类型从 `lib/contract.ts` 取，不要手写字段。**
 * 手写过一版（`{ dept?: string | null; roles: string[] }`）—— 那是照个人中心
 * 那屏的 `CurrentUser` 记的，而列表这个 DTO 的 `dept` / `roles` 是**对象**。
 * 手写声明会和契约分叉，编译器只会说「数据不匹配这个组件」。
 */
function UserRow({ user, onPress }: { user: UserListItem; onPress: () => void }) {
  const { t } = useTranslation()
  const name = user.nickname || user.username

  return (
    /*
     * 🔴 **`active:` 只在 uniwind 的 `Pressable` 包装里解析，挂在别的组件上是死代码。**
     * 这里原来是 `<Pressable><Card className="active:bg-muted …">`，那个 `active:`
     * **一次都不会生效** —— 读 uniwind 的实现：`Pressable.js` 把 `style` 传成
     * 函数并在 `state.pressed` 时带上 `isPressed` 重算，而 `View.js`（`Card` 就是
     * 一个 View）只有 `useStyle(className, props)`，压根没有 pressed 这一维。
     * 不报错、不警告，就是按下去没反应。
     *
     * 所以行本身就是 Pressable、自己画卡片表面，不再套 `Card`
     * （仓库里其余 `active:` 也都在 Pressable 上：`grouped.tsx` 的 `PressRow` /
     * `DangerRow`、通知列表那一行）。
     */
    <Pressable
      onPress={onPress}
      testID={`user-row-${user.id}`}
      className="bg-card active:bg-muted flex-row items-center gap-3 rounded-xl px-4 py-3"
    >
      <Avatar alt={name} className="size-11 rounded-[14px]">
        {user.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
        <AvatarFallback className="bg-primary rounded-[14px]">
          <Text className="text-primary-foreground font-semibold">{name.slice(0, 1).toUpperCase()}</Text>
        </AvatarFallback>
      </Avatar>
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-[15px] font-medium" numberOfLines={1}>
            {name}
          </Text>
          {/* 停用才出徽标 —— 「启用」是常态，给常态挂标签等于满屏噪音 */}
          {user.status === 0 ? (
            <Badge variant="secondary">
              <Text>{t('停用')}</Text>
            </Badge>
          ) : null}
        </View>
        <Text className="text-muted-foreground text-xs" numberOfLines={1}>
          @{user.username}
          {/* ⚠️ `dept` 是对象、`roles` 是对象数组 —— 见 `UserListItem` 的注释 */}
          {user.dept?.name ? ` · ${user.dept.name}` : ''}
          {user.roles.length > 0 ? ` · ${user.roles.map((r) => r.name).join('、')}` : ''}
        </Text>
      </View>
      <Icon as={ChevronRightIcon} className="text-muted-foreground size-4 opacity-40" />
    </Pressable>
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
