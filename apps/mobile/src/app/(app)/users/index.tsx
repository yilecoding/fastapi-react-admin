import { useRouter } from 'expo-router'
import { SearchIcon, TriangleAlertIcon, UsersIcon, XIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { GroupHeader } from '@/components/grouped'
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

/** 分隔线内缩到文字起点：左内边距 16 + 头像 44 + 间距 12 */
const SEPARATOR_INSET = 72

/**
 * 用户列表 —— **移动端「分页列表」的范式样板**。
 *
 * 通知那一屏是 `size: 50` 一次拉完 + `ScrollView` + `map()`，那个形状在
 * 几十条以内看不出问题，上千条就废了。这一屏是要被抄的那一份：
 * `useInfiniteQuery` + `FlatList` + 防抖搜索 + 五个状态。
 *
 * ## 🔴 长列表是**通栏连续白面**，不是带间距的浮动卡片
 *
 * 第一版写成了「每条一张 `rounded-xl` 卡 + `gap-2.5`」，理由是
 * `grouped.tsx` 的 `Group`（一个 `Card` 包住所有行）和虚拟化冲突 ——
 * 那个理由是对的，但**推出的结论错了**：`Group` 用不了不等于要改成浮动卡片。
 * 带间距的圆角卡是 web / Material 的语言，而这个 App 通篇是 iOS 分组列表
 * （见本目录的 `components/` 分册）。混在一起的结果就是「这一屏不像这个 App」。
 *
 * iOS 自己的长实体列表（通讯录、邮件）是**通栏、无圆角、无间距**，
 * 行与行之间一条**内缩到文字起点**的发丝线。那个形状恰好和虚拟化没有冲突 ——
 * 因为它**根本不需要一个跨全表的容器**：白色由每一行自己画，
 * 分隔线走 `ItemSeparatorComponent`。
 *
 * ⚠️ 分隔线那个组件也要 `bg-card` —— 它渲染在行**之外**，
 * 只给里层发丝线上色的话，内缩掉的那 72px 会漏出页面底色（#f4f2fa），
 * 于是每条线左边多一截浅灰，很脏。
 *
 * ## 🔴 五个状态，缺一个都会变成「这 App 坏了」
 *
 * | 状态 | 长什么样 | 为什么不能省 |
 * |---|---|---|
 * | 首屏加载 | **骨架行**（照真实行的形状排，不是几个灰块） | —— |
 * | **首屏失败** | 占位的错误块 + 重试 | 硬纪律 9。不能和「一条都没有」长得一样 |
 * | 空（没筛选） | 「还没有用户」 | —— |
 * | 空（筛了） | 「没有匹配」+ 提示改条件 | 和上一条**必须分开**：用户筛出空白时第一反应是「搜坏了」 |
 * | **翻页失败** | 列表底部一条错误 + 重试 | ⚠️ 最容易漏 —— 前面的数据是好的，**不能**把整屏换成错误块 |
 * | 下拉刷新失败 | `toast.error` | 这一屏唯一**没有位置可占**的失败：内容还在（上一次那份，仍可读） |
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
      {/*
        搜索框：iOS 那种**填充式**（`bg-muted` 无描边），不是 shadcn 的描边 input。
        描边白底那个是桌面语言，放在灰底分组列表上会显得是"另一个 App 的控件"。
      */}
      <View className="px-4 pt-3 pb-2">
        <View className="bg-muted h-10 flex-row items-center gap-2 rounded-xl px-3">
          <Icon as={SearchIcon} className="text-muted-foreground size-[17px]" />
          <Input
            value={keyword}
            onChangeText={setKeyword}
            placeholder={t('搜索用户名')}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            testID="users-search"
            className="h-10 flex-1 border-0 bg-transparent px-0 text-[15px] shadow-none"
          />
          {/* 🔴 手机上必须有个清空口 —— 全选删除很难点，而收起键盘之后
              那几个字符会一直卡着筛选条件，用户会以为"列表就这么少" */}
          {keyword.length > 0 ? (
            <Pressable onPress={() => setKeyword('')} hitSlop={10} testID="users-search-clear">
              <View className="bg-muted-foreground/25 size-[18px] items-center justify-center rounded-full">
                <Icon as={XIcon} className="text-card size-3" />
              </View>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* 分段控件占满整行。⚠️ `TabsList` 默认 `mr-auto`（内容宽），要显式 `w-full` */}
      <View className="px-4 pb-1">
        <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <TabsList className="w-full flex-row">
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
        <SkeletonRows />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(u) => String(u.id)}
          contentContainerClassName="pb-10"
          refreshControl={
            <RefreshControl
              refreshing={q.isRefetching && !q.isFetchingNextPage}
              onRefresh={() => void onPullRefresh()}
            />
          }
          /*
           * 🔴 `onEndReachedThreshold` 的单位是**屏高的倍数**，不是像素。
           * 0.5 = 还差半屏就开始拉下一页，翻到底时几乎看不到等待。
           */
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            // 🔴 `onEndReached` 一次滚动里会被调多次，不挡住会连发几页。
            // 占位期间（`isPlaceholderData`）显示的是**上一套筛选条件**的数据，
            // 此时 `hasNextPage` / 页码都属于旧的那一套 —— 翻页会把两套结果串起来
            if (q.hasNextPage && !q.isFetchingNextPage && !q.isPlaceholderData) void q.fetchNextPage()
          }}
          /*
           * 计数是**分组抬头**，不再挤在筛选那一行的右端 —— 那一行塞了三个页签
           * 之后已经满了，再加一段文字就是"什么都想放进去"的样子。
           * ⚠️ 只在真的知道时显示：拉失败时 `?? 0` 会渲染成「共 0 人」，
           * 那是一个看起来像结论的假数字。
           */
          ListHeaderComponent={
            <>
              <View className="flex-row items-center justify-between pe-4">
                <GroupHeader>
                  {filtering ? t('筛选结果') : t('全部用户')}
                </GroupHeader>
                {/* 占位期间转个圈：屏上还是旧结果，不给信号的话看起来像「搜了但没反应」 */}
                {q.isPlaceholderData && q.isFetching ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text className="text-muted-foreground pt-4 pb-2 text-xs" testID="users-total">
                    {t('共 {{n}} 人', { n: total })}
                  </Text>
                )}
              </View>
              {items.length > 0 ? <View className="bg-border h-px" /> : null}
            </>
          }
          ItemSeparatorComponent={Separator}
          ListEmptyComponent={
            <View className="items-center gap-2 px-10 pt-16">
              <Icon as={UsersIcon} className="text-muted-foreground size-8" />
              <Text variant="small" className="text-muted-foreground">
                {t(filtering ? '没有匹配的用户' : '还没有用户')}
              </Text>
              <Text className="text-muted-foreground/70 text-center text-xs leading-5">
                {t(filtering ? '换个关键词，或把筛选切回「全部」' : '后台创建的用户会出现在这里')}
              </Text>
            </View>
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

/**
 * 行间分隔线。
 *
 * ⚠️ **外层那个 `bg-card` 不能省。** 这个组件渲染在两行**之间**、在行的背景之外，
 * 只给里层发丝线上色的话，内缩掉的 72px 会漏出页面底色（#f4f2fa）——
 * 每条线左边多一截浅灰，列表看起来是脏的。
 */
function Separator() {
  return (
    <View className="bg-card">
      <View className="bg-border h-px" style={{ marginLeft: SEPARATOR_INSET }} />
    </View>
  )
}

/**
 * 骨架屏**照真实行的形状排**，不是几个圆角灰块。
 *
 * 灰块版本会让首屏和「加载完之后」两次布局完全不同，读起来是"闪了一下变成另一个东西"。
 */
function SkeletonRows() {
  return (
    <View>
      <View className="h-10" />
      <View className="bg-border h-px" />
      <View className="bg-card">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View key={i}>
            {i === 0 ? null : <View className="bg-border h-px" style={{ marginLeft: SEPARATOR_INSET }} />}
            <View className="flex-row items-center gap-3 px-4 py-3">
              <Skeleton className="size-11 rounded-[14px]" />
              <View className="flex-1 gap-2">
                <Skeleton className="h-3.5 w-28 rounded-md" />
                <Skeleton className="h-3 w-44 rounded-md" />
              </View>
            </View>
          </View>
        ))}
      </View>
      <View className="bg-border h-px" />
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

  // 列表底边：让通栏白面有个明确的收口
  const bottomLine = count > 0 ? <View className="bg-border h-px" /> : null

  if (error) {
    return (
      <>
        {bottomLine}
        <View className="items-center gap-2 pt-4">
          <Text className="text-destructive text-xs">{t('加载更多失败')}</Text>
          <Button variant="outline" size="sm" onPress={onRetry}>
            <Text>{t('重试')}</Text>
          </Button>
        </View>
      </>
    )
  }
  if (loading) {
    return (
      <>
        {bottomLine}
        <View className="items-center pt-4">
          <ActivityIndicator size="small" />
        </View>
      </>
    )
  }
  return (
    <>
      {bottomLine}
      {/* 只有真的翻过页才说「没有更多了」——一屏就装完的时候这句是噪音 */}
      {!hasMore && count > 0 ? (
        <Text className="text-muted-foreground/70 pt-3 text-center text-xs">{t('没有更多了')}</Text>
      ) : null}
    </>
  )
}

/**
 * 一行 = 头像 + 两行文字 + 右侧状态。
 *
 * 🔴 **props 的类型从 `lib/contract.ts` 取，不要手写字段。**
 * 手写过一版（`{ dept?: string | null; roles: string[] }`）—— 那是照个人中心
 * 那屏的 `CurrentUser` 记的，而列表这个 DTO 的 `dept` / `roles` 是**对象**。
 * 手写声明会和契约分叉，编译器只会说「数据不匹配这个组件」。
 *
 * ⚠️ **第二行只放 `@用户名 · 部门`，不放角色。** 第一版把
 * `@username · dept · roles.join('、')` 全串在一行，一个挂三个角色的账号就把
 * 那行顶到省略号，整列看过去是一片糊字 —— 这是"太丑"里最具体的那一条。
 * 角色在详情屏有，列表不用替它操心。
 *
 * ⚠️ **没有 chevron。** iOS 的长实体列表（通讯录 / 邮件）都不带 ——
 * 有头像的行本身就读作可点，20 行 chevron 只是 20 个重复的小箭头。
 * `grouped.tsx` 的 `PressRow` 带 chevron 是因为那是**设置类**的定长列表，两回事。
 */
function UserRow({ user, onPress }: { user: UserListItem; onPress: () => void }) {
  const { t } = useTranslation()
  const name = user.nickname || user.username
  const disabled = user.status === 0

  return (
    /*
     * 🔴 **`active:` 只在 uniwind 的 `Pressable` 包装里解析，挂在别的组件上是死代码。**
     * 读过它的实现：`Pressable` 那个包装把 `style` 传成函数、在 `state.pressed` 时
     * 带 `isPressed` 重算；`View` 那个包装只有 `useStyle(className, props)`，
     * 压根没有 pressed 这一维。写在 `Card`（一个 View）上不报错、不警告，
     * 就是按下去没反应。
     */
    <Pressable
      onPress={onPress}
      testID={`user-row-${user.id}`}
      className="bg-card active:bg-muted flex-row items-center gap-3 px-4 py-3"
    >
      <Avatar alt={name} className="size-11 rounded-[14px]">
        {user.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
        {/* 停用的账号头像去掉主色，否则一列紫方块里看不出谁是停用的 */}
        <AvatarFallback className={`rounded-[14px] ${disabled ? 'bg-muted-foreground/30' : 'bg-primary'}`}>
          <Text className={`font-semibold ${disabled ? 'text-card' : 'text-primary-foreground'}`}>
            {name.slice(0, 1).toUpperCase()}
          </Text>
        </AvatarFallback>
      </Avatar>

      <View className="flex-1 gap-0.5">
        <Text className="text-[16px] font-medium" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
          @{user.username}
          {user.dept?.name ? ` · ${user.dept.name}` : ''}
        </Text>
      </View>

      {/* 状态表达在**值**上（定稿那版的规则），不动图标、不给常态挂标签 */}
      {disabled ? <Text className="text-muted-foreground shrink-0 text-[13px]">{t('停用')}</Text> : null}
    </Pressable>
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
