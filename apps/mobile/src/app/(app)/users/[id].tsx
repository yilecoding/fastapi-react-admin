import { useLocalSearchParams, useRouter } from 'expo-router'
import { Trash2Icon, TriangleAlertIcon, UserRoundXIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ScrollView, View } from 'react-native'

import { ApiError } from '@admin/api'
import { formatDateTime } from '@admin/i18n'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Group, GroupHeader, Row } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { usePerm } from '@/lib/perm'
import { useSession } from '@/lib/session'
import { useDeleteUser, useUser } from '@/lib/users'

/**
 * 用户详情 —— **移动端「详情屏 + 一个写操作」的范式样板**。
 *
 * 在这之前 `src/app/` 下**没有任何动态路由**（`[id].tsx` 一个都没有），
 * 于是这几件事在仓库里查无实据：雪花 ID 怎么当路径参数传、详情的三种失败态
 * 长什么样、写完之后列表那份缓存怎么纠正。
 *
 * ## 🔴 路径参数：`useLocalSearchParams` 拿到的是 `string | string[]`
 *
 * expo-router 的参数**不保证是单值** —— 同名参数出现两次就是数组。
 * 「随手 `String(params.id)`」在数组情况下会得到 `"a,b"`，所以显式取第一个。
 *
 * 🔴 **拿到之后原样当字符串用，绝对不要 `Number()`。**
 * schema 里 `pk` 声明成 `number`，而 openapi-fetch **不检查路径参数**
 * （实测：`params.path` 传 `string` 零报错；同一个调用里把查询参数名写错
 * 才报 `TS2561`）。所以编译器两个方向都不管：既不逼你转，也不挡你转。
 * 转了就是硬纪律 6 —— 雪花 ID 丢精度，连续几个还会塌成同一个值。
 */
export default function UserDetailScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '')

  const { user: me } = useSession()
  const { canWrite } = usePerm()
  const q = useUser(id)
  const del = useDeleteUser()
  const [confirming, setConfirming] = React.useState(false)

  const user = q.data ?? null
  const name = user ? user.nickname || user.username : ''

  /*
   * 🔴 **自己不能删自己。** 后端 `user_service.delete` **没有**这道守卫
   * （读过那个函数：查到就删，然后把该用户的三组 token key 全清掉）——
   * 删自己会成功，然后当前会话立刻失效、被弹回登录屏，看起来像「App 把我踢了」。
   * 这道守卫只能在客户端做。
   *
   * ⚠️ 判据比 `id`，**不要比用户名**（可以改）。两边都 `String()` 是因为
   * `id` 在 schema 里是 `string | number`（`field_serializer` 那个联合），
   * 而路由参数一定是字符串 —— 不统一的话 `===` 永远为假，守卫**静默失效**。
   */
  const isSelf = me !== null && user !== null && String(me.id) === String(user.id)
  const canDelete = canWrite('sys:user:del') && !isSelf

  function onConfirmDelete() {
    del.mutate(id, {
      onSuccess: () => {
        setConfirming(false)
        // 🔴 先回退再报成功：这一屏的缓存已经被 `removeQueries` 清掉了，
        // 留在原地会渲染成「这个用户不存在」—— 那不是错误，只是我们刚删了它
        router.back()
        toast.success(t('已删除「{{name}}」', { name }))
      },
      onError: (err) => {
        setConfirming(false)
        // 写操作的失败走 toast，不走屏内错误块 —— 屏上的内容还是对的
        // （删除失败 = 用户还在），没有位置可占（见 `ui/toast.tsx` 头注释）
        toast.error(t('删除失败'), { description: err instanceof Error ? err.message : String(err) })
      },
    })
  }

  if (q.isPending) {
    return (
      <View className="bg-background flex-1 gap-3 p-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </View>
    )
  }

  if (q.isError || user === null) {
    return <DetailError error={q.error} onRetry={() => void q.refetch()} />
  }

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="pb-10">
      <View className="flex-row items-center gap-3.5 px-5 pt-4 pb-1">
        <Avatar alt={name} className="size-[54px] rounded-[17px]">
          {user.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
          <AvatarFallback className="bg-primary rounded-[17px]">
            <Text className="text-primary-foreground text-xl font-semibold">{name.slice(0, 1).toUpperCase()}</Text>
          </AvatarFallback>
        </Avatar>
        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="shrink text-lg font-semibold" numberOfLines={1} testID="user-detail-name">
              {name}
            </Text>
            {user.status === 0 ? (
              <Badge variant="secondary">
                <Text>{t('停用')}</Text>
              </Badge>
            ) : null}
          </View>
          <Text className="text-muted-foreground font-mono text-xs">@{user.username}</Text>
        </View>
      </View>

      <GroupHeader>{t('资料')}</GroupHeader>
      <Group>
        {/* ⚠️ 这个 DTO 的 `dept` 是对象、`roles` 是对象数组（和 `/users/me`
            那份**不一样**）—— 见 `lib/contract.ts` 里 `UserListItem` 的注释 */}
        <Field first label={t('部门')} value={user.dept?.name} />
        <Field label={t('角色')} value={user.roles.map((r) => r.name).join('、')} />
        <Field label={t('手机号')} value={user.phone} />
        <Field label={t('邮箱')} value={user.email} />
        <Field label={t('账号类型')} value={t(accountKind(user))} />
        {/* ⚠️ 服务端时间一律过 `@admin/i18n` 的 datetime 层（根 CLAUDE.md）——
            不要裸打印、切片或按字典序比较 */}
        <Field label={t('加入时间')} value={formatDateTime(user.join_time)} mono />
        <Field label={t('最后登录')} value={user.last_login_time ? formatDateTime(user.last_login_time) : null} mono />
        {/* 🔴 只展示，就地 `String()`。**不要 `Number()`**（硬纪律 6） */}
        <Field label={t('账号 ID')} value={String(user.id)} mono />
      </Group>

      {/*
        权限不够时**整块不出现**。这不违反硬纪律 9 —— 那条管的是「请求失败别伪装成
        功能不存在」，而这里是真的没有这个权限，区别在于**有没有发生错误**。
        ⚠️ 但权限码**拉失败**时 `can()` 也一律返回 false，所以那一层要用
        `usePerm()` 的 `known` 兜住；统一兜在「应用」那一屏（`(tabs)/apps.tsx`），
        进得来这一屏就说明权限码是问到过的。
      */}
      {canDelete ? (
        <View className="px-4 pt-5">
          <Button
            variant="destructive"
            onPress={() => setConfirming(true)}
            testID="user-delete"
            className="h-[50px] rounded-xl"
          >
            <Icon as={Trash2Icon} className="size-[18px] text-white" />
            <Text className="text-[15px] font-semibold">{t('删除用户')}</Text>
          </Button>
        </View>
      ) : null}
      {isSelf ? (
        <Text className="text-muted-foreground px-5 pt-4 text-xs leading-5">
          {t('这是你自己的账号，不能在这里删除。')}
        </Text>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        busy={del.isPending}
        title={t('删除用户')}
        description={t('「{{name}}」及其角色关联会被一起删除，且无法恢复。', { name })}
        confirmLabel={t('删除')}
        cancelLabel={t('取消')}
        onConfirm={onConfirmDelete}
        testID="user-delete-confirm"
      />
    </ScrollView>
  )
}

/**
 * 详情的三种失败态。
 *
 * 🔴 **404 / 403 / 其它必须分开。** 全渲染成「加载失败 + 重试」的话，
 * 一个被删掉的用户会得到一个**点了永远不会成功的重试按钮**，
 * 而没有权限的人会以为是网络问题。
 */
function DetailError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  const apiErr = error instanceof ApiError ? error : null
  const gone = apiErr?.httpStatus === 404
  const forbidden = apiErr?.isForbidden ?? false

  if (gone || forbidden) {
    return (
      <View className="bg-background flex-1 items-center justify-center gap-2 px-10">
        <Icon as={UserRoundXIcon} className="text-muted-foreground size-9" />
        <Text variant="small" className="text-muted-foreground">
          {t(gone ? '这个用户不存在' : '你没有查看这个用户的权限')}
        </Text>
        <Text className="text-muted-foreground/70 text-center text-xs leading-5">
          {t(gone ? '可能已经被删除了。' : '需要「用户查询」权限，找管理员分配。')}
        </Text>
      </View>
    )
  }

  return (
    <View className="bg-background flex-1 p-4">
      <Alert variant="destructive" icon={TriangleAlertIcon}>
        <AlertTitle>{t('用户拉取失败')}</AlertTitle>
        <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
        <Button variant="outline" size="sm" onPress={onRetry} className="mt-2 self-start">
          <Text>{t('重试')}</Text>
        </Button>
      </Alert>
    </View>
  )
}

/** ⚠️ 返回 **key**，由调用处 `t()` */
function accountKind(user: { is_superuser: boolean; is_staff: boolean }) {
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}

function Field({
  first,
  label,
  value,
  mono,
}: {
  first?: boolean
  label: string
  value?: string | null
  mono?: boolean
}) {
  return (
    <Row first={first} className="items-start">
      <Text className="shrink-0 text-[15px]">{label}</Text>
      <View className="flex-1 items-end">
        <Text
          className={`text-muted-foreground text-right ${mono ? 'font-mono text-xs' : 'text-[14px]'}`}
          numberOfLines={2}
        >
          {value?.trim() ? value : '—'}
        </Text>
      </View>
    </Row>
  )
}
