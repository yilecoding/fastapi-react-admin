import { useRouter } from 'expo-router'
import {
  Building2Icon,
  ChevronRightIcon,
  FolderIcon,
  LayoutGridIcon,
  ListTreeIcon,
  LockIcon,
  LogInIcon,
  ScrollTextIcon,
  ShieldIcon,
  TriangleAlertIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BrandTop } from '@/components/brand-top'
import { Button } from '@/components/ui/button'
import { Chevron, Group, GroupHeader, PressRow, RowIcon } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { usePerm } from '@/lib/perm'

/**
 * 「应用」—— **按权限码列出能进的模块**。
 *
 * 这一屏的副标题一直写着「按你的权限列出能进的功能模块」，而在
 * `lib/perm.ts` 之前移动端**完全没有权限概念**（`CurrentUser` 里只有角色
 * 名字），所以它是一个空屏 + 一句「还没做」。现在它是真的。
 *
 * ## 🔴 三种「空」必须分开，否则全都长成「这 App 坏了」
 *
 * | 情况 | 屏上 |
 * |---|---|
 * | 权限码还在拉 | 骨架屏 |
 * | **权限码拉失败** | 错误块 + 重试（硬纪律 9：`can()` 此时一律 false，不兜住的话入口全消失、看着像功能不存在） |
 * | 拉到了、但一个模块都没授权 | 「没有可用模块」+ 说清是权限问题、找谁 |
 *
 * 中间那一条是这一屏存在的主要理由。**权限门控天生会把错误伪装成缺失**：
 * `can()` 返回 false 的原因有两个（真没权限 / 没问上），而界面上长得一样。
 * `usePerm()` 的 `known` 就是用来分开它们的。
 *
 * ## 加一个模块要改的就是下面那张表
 *
 * 一条 = 图标 + 文案 + **权限码** + 目标路由。没有 `href` 的条目表示
 * 「后端有、移动端这一屏还没做」—— 刻意留着，因为 `perms` 那一列是这张表
 * 唯一容易写错的地方，对着后端 `RequestPermission('…')` 抄一次比事后猜便宜。
 */
type Module = {
  key: string
  /** ⚠️ 存 **key**，渲染时才 `t()` —— 模块级常量切语言不会变 */
  label: string
  hint: string
  icon: LucideIcon
  /** 后端 `Depends(RequestPermission('…'))` 里那个码，任一满足即可进 */
  perms: string[]
  /** 移动端还没做这一屏时留空 */
  href?: '/users'
}

const MODULES: Module[] = [
  {
    key: 'users',
    label: '用户',
    hint: '查看 · 搜索 · 删除',
    icon: UsersIcon,
    perms: ['sys:user:list'],
    href: '/users',
  },
  // ⚠️ 下面这些**后端有、移动端还没做这一屏**。留在表里而不是删掉，是因为
  // `perms` 那一列对着后端 `Depends(RequestPermission('…'))` 抄一次最便宜；
  // 而且它们会渲染成一句「还没做的」，那比「这个功能不存在」诚实。
  { key: 'roles', label: '角色', hint: '', icon: ShieldIcon, perms: ['sys:role:list'] },
  { key: 'depts', label: '部门', hint: '', icon: Building2Icon, perms: ['sys:dept:list'] },
  { key: 'menus', label: '菜单', hint: '', icon: ListTreeIcon, perms: ['sys:menu:list'] },
  { key: 'files', label: '文件', hint: '', icon: FolderIcon, perms: ['sys:file:list'] },
  { key: 'opera-log', label: '操作日志', hint: '', icon: ScrollTextIcon, perms: ['log:opera:list'] },
  { key: 'login-log', label: '登录日志', hint: '', icon: LogInIcon, perms: ['log:login:list'] },
]

export default function AppsScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const { canAny, known, error, codes, isSuperuser, refresh } = usePerm()
  const [refreshing, setRefreshing] = React.useState(false)

  async function onRefresh() {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  // ⚠️ 只有 `known` 之后才谈「有哪些」—— 之前算出来的一定是空数组
  const allowed = known ? MODULES.filter((m) => m.href && canAny(...m.perms)) : []

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <BrandTop>
        <View className="gap-1 pt-1">
          <Text className="text-3xl font-bold" style={{ letterSpacing: -0.9 }}>
            {t('应用')}
          </Text>
          <Text className="text-muted-foreground text-[13px]">{t('按你的权限列出能进的功能模块')}</Text>
        </View>
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
      ) : !known ? (
        <View className="gap-3 px-4 pt-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </View>
      ) : allowed.length === 0 ? (
        <>
          <GroupHeader>{t('可用模块')}</GroupHeader>
          <Group className="items-center gap-2 py-10">
            <Icon as={LockIcon} className="text-muted-foreground size-8" />
            <Text variant="small" className="text-muted-foreground">
              {t('没有可用模块')}
            </Text>
            <Text className="text-muted-foreground/70 px-8 text-center text-xs leading-5">
              {t('你的账号还没有被分配这些模块的权限，找管理员在「角色」里勾上。')}
            </Text>
          </Group>
        </>
      ) : (
        <>
          <GroupHeader>{t('可用模块')}</GroupHeader>
          <Group>
            {allowed.map((m, i) => (
              <PressRow
                key={m.key}
                first={i === 0}
                inset={56}
                testID={`module-${m.key}`}
                onPress={() => {
                  if (m.href) router.push(m.href)
                }}
              >
                <RowIcon icon={m.icon} />
                <Text className="flex-1 text-[15px]">{t(m.label)}</Text>
                {m.hint ? <Text className="text-muted-foreground text-[13px]">{t(m.hint)}</Text> : null}
                <Chevron icon={ChevronRightIcon} />
              </PressRow>
            ))}
          </Group>
        </>
      )}

      {/* 把权限层做成可见的 —— 排查「为什么这个入口不出现」时第一眼看这里 */}
      {known ? (
        <Text className="text-muted-foreground/70 px-5 pt-3 text-xs leading-5" testID="perm-summary">
          {isSuperuser ? t('超级管理员，不受权限码限制。') : t('已授权 {{n}} 项权限。', { n: codes.length })}
        </Text>
      ) : null}

      {/* 还没做的模块：明说「还没做」，不要长得像「没权限」 */}
      {known && MODULES.some((m) => !m.href) ? (
        <>
          <GroupHeader>{t('还没做的')}</GroupHeader>
          <Group className="py-3">
            <View className="flex-row items-center gap-2 px-5">
              <Icon as={LayoutGridIcon} className="text-muted-foreground size-4" />
              <Text className="text-muted-foreground flex-1 text-xs leading-5">
                {t('后端有、移动端还没做这一屏的模块：{{list}}', {
                  list: MODULES.filter((m) => !m.href)
                    .map((m) => t(m.label))
                    .join('、'),
                })}
              </Text>
            </View>
          </Group>
        </>
      ) : null}
    </ScrollView>
  )
}
