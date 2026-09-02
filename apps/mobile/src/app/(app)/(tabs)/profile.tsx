import { useRouter } from 'expo-router'
import { ChevronRightIcon, KeyRoundIcon, LogOutIcon, SquarePenIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { Separator } from '@/components/ui/separator'
import { Text } from '@/components/ui/text'
import { useSession } from '@/lib/session'

export default function ProfileScreen() {
  const { user, reload, logout } = useSession()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function onRefresh() {
    setRefreshing(true)
    setError(null)
    try {
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  if (!user) return null

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 12 }}
      contentContainerClassName="gap-4 px-4 pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <Card>
        <CardContent className="flex-row items-center gap-4">
          <Avatar alt={user.nickname || user.username} className="size-14">
            {/* 头像地址坏掉时 AvatarImage 静默不显示，AvatarFallback 兜住 —— 
                「没有头像」和「头像挂了」都有一个确定的样子 */}
            {user.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
            <AvatarFallback>
              <Text className="text-lg font-semibold">
                {(user.nickname || user.username).slice(0, 1).toUpperCase()}
              </Text>
            </AvatarFallback>
          </Avatar>
          <View className="flex-1 gap-1">
            <Text className="text-xl font-semibold">{user.nickname || user.username}</Text>
            <Text variant="small" className="text-muted-foreground font-mono">
              @{user.username}
            </Text>
          </View>
          <Badge variant="secondary">
            <Text>{accountKind(user)}</Text>
          </Badge>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive" icon={LogOutIcon}>
          <AlertTitle>刷新失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="gap-0 px-0">
          <Field label="部门" value={user.dept} first />
          <Field label="角色" value={user.roles.join('、')} />
          {/* 🔴 手机号和邮箱是**只读**的，不是漏做：
              - 手机号：后端**没有** `/me/phone`，只有超管能改（`PUT /sys/users/{pk}`）
              - 邮箱：`PUT /me/email` 要邮箱验证码，那条链路移动端还没有
              与其放一个改了会失败的输入框，不如把原因写在这儿。 */}
          <Field label="手机号" value={user.phone} note="需管理员修改" />
          <Field label="邮箱" value={user.email} note="改邮箱要邮件验证码" />
          <Field label="时区" value={user.timezone} mono />
          <Field label="账号 ID" value={user.id} mono />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="gap-0 px-0">
          <Action icon={SquarePenIcon} label="编辑资料" onPress={() => router.push('/profile/edit')} first testID="profile-edit" />
          <Action icon={KeyRoundIcon} label="修改密码" onPress={() => router.push('/profile/password')} testID="profile-password" />
        </CardContent>
      </Card>

      {/* 登出单独一张卡 —— 它不是和「编辑资料」同一量级的操作 */}
      <Card>
        <CardContent className="px-0">
          <Pressable
            onPress={() => void logout()}
            testID="profile-logout"
            className="active:bg-accent flex-row items-center justify-center gap-2 px-6 py-1"
          >
            <Icon as={LogOutIcon} className="text-destructive size-4" />
            <Text className="text-destructive font-medium">退出登录</Text>
          </Pressable>
        </CardContent>
      </Card>
    </ScrollView>
  )
}

function accountKind(user: { is_superuser: boolean; is_staff: boolean }) {
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}

function Field({
  label,
  value,
  note,
  mono,
  first,
}: {
  label: string
  value?: string | null
  note?: string
  mono?: boolean
  first?: boolean
}) {
  return (
    <>
      {first ? null : <Separator className="my-0" />}
      <View className="min-h-[48px] flex-row items-center gap-4 px-6 py-2.5">
        <Text variant="small" className="text-muted-foreground shrink-0">
          {label}
        </Text>
        <View className="flex-1 items-end">
          <Text className={`text-right text-sm ${mono ? 'font-mono text-xs' : ''}`} numberOfLines={2}>
            {value?.trim() ? value : '—'}
          </Text>
          {note ? (
            <Text className="text-muted-foreground mt-0.5 text-right text-xs">{note}</Text>
          ) : null}
        </View>
      </View>
    </>
  )
}

function Action({
  icon,
  label,
  onPress,
  first,
  testID,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  label: string
  onPress: () => void
  first?: boolean
  testID?: string
}) {
  return (
    <>
      {first ? null : <Separator className="my-0" />}
      <Pressable
        onPress={onPress}
        testID={testID}
        className="active:bg-accent min-h-[48px] flex-row items-center gap-3 px-6 py-2.5"
      >
        <Icon as={icon} className="text-muted-foreground size-4" />
        <Text className="flex-1 text-sm">{label}</Text>
        <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
      </Pressable>
    </>
  )
}
