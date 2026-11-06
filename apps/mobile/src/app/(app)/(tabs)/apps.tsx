import { useRouter, type Href } from 'expo-router'
import {
  FilePlusIcon,
  BellIcon,
  FileCheckIcon,
  IdCardIcon,
  LockIcon,
  SettingsIcon,
  TriangleAlertIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BrandTop } from '@/components/brand-top'
import { Button } from '@/components/ui/button'
import { GroupHeader } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { useUnread } from '@/lib/notifications'
import { usePerm } from '@/lib/perm'
import { isWorkflowMissing, useWorkflowCounts } from '@/lib/workflow'

/**
 * 「应用」—— 启动台：按分组排的图标宫格（参考钉钉 / 企业微信的工作台），不是导航列表。
 *
 * 原来这一屏是一条「用户」列表 + 一段「还没做的」，和首页的「入口」组长得一样，
 * 看起来就是个导航页。#224 定了移动端不做角色 / 部门 / 菜单 / 文件 / 日志，
 * 所以「还没做的」那段删掉，宫格里只放**真能进**的。新模块往 `SECTIONS` 里加一格。
 *
 * ## 🔴 三种「空」必须分开，否则全都长成「这 App 坏了」
 *
 * | 情况 | 屏上 |
 * |---|---|
 * | 权限码还在拉 | 骨架屏（宫格形状） |
 * | **权限码拉失败** | 错误块 + 重试（硬纪律 9：`can()` 此时一律 false，不兜住的话入口全消失、看着像功能不存在） |
 * | 拉到了、但一个模块都没授权 | 「没有可用模块」+ 说清是权限问题、找谁 |
 *
 * 只有挂了 `perms` 的格子受这三种状态影响；不要权限的格子（通知、个人资料、设置）**始终显示** ——
 * 权限没拉到不该让用户连设置都找不到。
 */
type Tile = {
  key: string
  /** ⚠️ 存 **key**，渲染时才 `t()` —— 模块级常量切语言不会变 */
  label: string
  icon: LucideIcon
  /** 格子底色：Tailwind 色板的 `/15` 半透明底，深浅色主题下都成立 */
  bg: string
  /** 图标色，和底色同一个色相 */
  fg: string
  href: Href
  /** 后端 `Depends(RequestPermission('…'))` 里那个码，任一满足即可进；不填 = 人人可进 */
  perms?: string[]
  /** 靠哪个服务端插件。没装时接口 404，格子不出（`isWorkflowMissing`，#257） */
  plugin?: 'workflow'
}

type Section = { key: string; title: string; tiles: Tile[] }

const SECTIONS: Section[] = [
  {
    key: 'common',
    title: '常用',
    tiles: [
      // 审批人人都可能是办理人，接口只要登录 —— 不挂权限码
      { key: 'workflow', label: '审批', icon: FileCheckIcon, bg: 'bg-orange-500/15', fg: 'text-orange-600 dark:text-orange-400', href: '/workflow', plugin: 'workflow' },
      { key: 'workflow-start', label: '发起审批', icon: FilePlusIcon, bg: 'bg-amber-500/15', fg: 'text-amber-600 dark:text-amber-400', href: '/workflow/start', plugin: 'workflow' },
      { key: 'notifications', label: '通知', icon: BellIcon, bg: 'bg-sky-500/15', fg: 'text-sky-600 dark:text-sky-400', href: '/notifications' },
      { key: 'profile', label: '个人资料', icon: IdCardIcon, bg: 'bg-violet-500/15', fg: 'text-violet-600 dark:text-violet-400', href: '/profile/info' },
      { key: 'settings', label: '设置', icon: SettingsIcon, bg: 'bg-slate-500/15', fg: 'text-slate-600 dark:text-slate-300', href: '/settings' },
    ],
  },
  {
    key: 'admin',
    title: '系统管理',
    tiles: [
      { key: 'users', label: '用户', icon: UsersIcon, bg: 'bg-emerald-500/15', fg: 'text-emerald-600 dark:text-emerald-400', href: '/users', perms: ['sys:user:list'] },
    ],
  },
]

export default function AppsScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const { canAny, known, error, refresh } = usePerm()
  const { unread, refresh: refreshUnread } = useUnread()
  const wfCounts = useWorkflowCounts()
  const [refreshing, setRefreshing] = React.useState(false)

  async function onRefresh() {
    setRefreshing(true)
    try {
      await Promise.all([refresh(), refreshUnread(), wfCounts.refetch()])
    } finally {
      setRefreshing(false)
    }
  }

  // 服务端没装审批插件：两个审批格子不出（点进去只会是一屏 404），不算错误
  const wfMissing = isWorkflowMissing(wfCounts.error)
  const gated = SECTIONS.some((s) => s.tiles.some((tile) => tile.perms))
  // ⚠️ 只有 `known` 之后才谈「有哪些」—— 之前 `canAny` 一律 false
  const visible = SECTIONS.map((s) => ({
    ...s,
    tiles: s.tiles.filter(
      (tile) => (!tile.perms || (known && canAny(...tile.perms))) && !(tile.plugin === 'workflow' && wfMissing),
    ),
  }))
  const noGranted = known && !SECTIONS.some((s) => s.tiles.some((tile) => tile.perms && canAny(...tile.perms)))
  const badges: Record<string, number> = { notifications: unread?.total ?? 0, workflow: wfCounts.data?.todo ?? 0 }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <BrandTop>
        <Text className="pt-1 text-3xl font-bold" style={{ letterSpacing: -0.9 }}>
          {t('应用')}
        </Text>
      </BrandTop>

      {/* 🔴 拉失败要占住位置，不能静默变成「没有模块」 */}
      {error && !known ? (
        <View className="px-4 pt-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('权限没问上')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void onRefresh()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : null}

      {visible.map((s) =>
        s.tiles.length > 0 ? (
          <React.Fragment key={s.key}>
            <GroupHeader>{t(s.title)}</GroupHeader>
            <TileGrid>
              {s.tiles.map((tile) => (
                <TileButton
                  key={tile.key}
                  tile={tile}
                  label={t(tile.label)}
                  badge={badges[tile.key] ?? 0}
                  onPress={() => router.push(tile.href)}
                />
              ))}
            </TileGrid>
          </React.Fragment>
        ) : null,
      )}

      {/* 有权限门控的格子还在拉权限码：占一个宫格形状的位，别让分组闪出来又消失 */}
      {gated && !known && !error ? (
        <>
          <GroupHeader>{t('系统管理')}</GroupHeader>
          <TileGrid>
            {[0, 1].map((i) => (
              <View key={i} className="w-1/4 items-center gap-2 py-3">
                <Skeleton className="size-[52px] rounded-2xl" />
                <Skeleton className="h-3 w-10 rounded" />
              </View>
            ))}
          </TileGrid>
        </>
      ) : null}

      {noGranted ? (
        <View className="items-center gap-2 px-8 pt-8" testID="apps-none-granted">
          <Icon as={LockIcon} className="text-muted-foreground size-6" />
          <Text className="text-muted-foreground text-center text-xs leading-5">
            {t('你的账号还没有被分配这些模块的权限，找管理员在「角色」里勾上。')}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  )
}

function TileGrid({ children }: { children: React.ReactNode }) {
  return <View className="bg-card mx-4 flex-row flex-wrap rounded-2xl px-1 py-2">{children}</View>
}

function TileButton({
  tile,
  label,
  badge,
  onPress,
}: {
  tile: Tile
  label: string
  badge: number
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={`module-${tile.key}`}
      accessibilityRole="button"
      accessibilityLabel={badge > 0 ? `${label}, ${badge}` : label}
      className="w-1/4 items-center gap-2 py-3 active:opacity-60"
    >
      <View className={`size-[52px] items-center justify-center rounded-2xl ${tile.bg}`}>
        <Icon as={tile.icon} className={`size-6 ${tile.fg}`} />
        {badge > 0 ? (
          <View className="bg-destructive absolute -top-1 -right-1 min-w-[18px] items-center rounded-full px-1">
            <Text className="text-[11px] font-semibold leading-[18px] text-white">{badge > 99 ? '99+' : badge}</Text>
          </View>
        ) : null}
      </View>
      <Text className="text-center text-[13px]" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}
