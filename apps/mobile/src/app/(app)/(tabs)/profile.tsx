import { useRouter } from 'expo-router'
import { ChevronRightIcon, KeyRoundIcon, LogOutIcon, SquarePenIcon } from 'lucide-react-native'
import * as React from 'react'
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Card, CardLabel, CardRow } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
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
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <View className="bg-primary px-5 pb-10" style={{ paddingTop: insets.top + 16 }}>
        <View className="flex-row items-center gap-4">
          <Avatar url={user.avatar} fallback={user.nickname || user.username} />
          <View className="flex-1 gap-1">
            <Text className="text-primary-foreground text-xl font-semibold" testID="profile-nickname">
              {user.nickname || user.username}
            </Text>
            <Text className="text-primary-foreground/70 text-sm">@{user.username}</Text>
          </View>
        </View>
      </View>

      <View className="-mt-5 gap-6 px-4">
        {error ? (
          <View className="border-destructive/40 bg-destructive/10 rounded-lg border p-3">
            <Text className="text-foreground text-sm">刷新失败：{error}</Text>
          </View>
        ) : null}

        <Card>
          <InfoRow first label="部门" value={user.dept} />
          <InfoRow label="角色" value={user.roles.join('、')} />
          {/* 🔴 手机号和邮箱在这里是**只读**的，不是漏做：
              - 手机号：后端**没有** `/me/phone` 这个口，只有超管能改（`PUT /sys/users/{pk}`）
              - 邮箱：`PUT /me/email` 要一个**邮箱验证码**，那条链路移动端还没有
              与其放一个改了会失败的输入框，不如把原因写在这儿。 */}
          <InfoRow label="手机号" value={user.phone} hint="需管理员修改" />
          <InfoRow label="邮箱" value={user.email} hint="改邮箱要邮件验证码" />
          <InfoRow label="时区" value={user.timezone} />
        </Card>

        <View>
          <CardLabel>账号</CardLabel>
          <Card>
            <ActionRow
              first
              icon={SquarePenIcon}
              label="编辑资料"
              onPress={() => router.push('/profile/edit')}
              testID="profile-edit"
            />
            <ActionRow
              icon={KeyRoundIcon}
              label="修改密码"
              onPress={() => router.push('/profile/password')}
              testID="profile-password"
            />
          </Card>
        </View>

        <Card>
          <ActionRow
            first
            danger
            icon={LogOutIcon}
            label="退出登录"
            onPress={() => void logout()}
            testID="profile-logout"
          />
        </Card>
      </View>
    </ScrollView>
  )
}

function InfoRow({
  first,
  label,
  value,
  hint,
}: {
  first?: boolean
  label: string
  value?: string | null
  hint?: string
}) {
  return (
    <CardRow first={first} className="items-start">
      <Text className="text-muted-foreground w-20 shrink-0 text-sm">{label}</Text>
      <View className="flex-1 items-end gap-0.5">
        <Text className="text-foreground text-right text-sm">{value?.trim() ? value : '—'}</Text>
        {hint ? <Text className="text-muted-foreground text-right text-xs">{hint}</Text> : null}
      </View>
    </CardRow>
  )
}

function ActionRow({
  first,
  icon,
  label,
  onPress,
  danger,
  testID,
}: {
  first?: boolean
  icon: React.ComponentProps<typeof Icon>['as']
  label: string
  onPress: () => void
  danger?: boolean
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className={`active:bg-accent flex-row items-center gap-3 px-4 py-3.5 ${first ? '' : 'border-border border-t'}`}
    >
      <Icon as={icon} className={danger ? 'text-destructive size-4.5' : 'text-muted-foreground size-4.5'} />
      <Text className={`flex-1 text-sm font-medium ${danger ? 'text-destructive' : 'text-foreground'}`}>
        {label}
      </Text>
      {danger ? null : <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />}
    </Pressable>
  )
}

function Avatar({ url, fallback }: { url: string | null; fallback: string }) {
  const [broken, setBroken] = React.useState(false)
  // 头像地址坏掉时 `Image` 默认渲染成一个**透明的洞**，看起来像布局塌了。
  // 回落到首字符，让「没有头像」和「头像挂了」都有一个确定的样子。
  if (!url || broken) {
    return (
      <View className="bg-primary-foreground/15 border-primary-foreground/25 h-16 w-16 items-center justify-center rounded-full border">
        <Text className="text-primary-foreground text-2xl font-semibold">
          {fallback.slice(0, 1).toUpperCase()}
        </Text>
      </View>
    )
  }
  return (
    <Image
      source={{ uri: url }}
      onError={() => setBroken(true)}
      style={{ width: 64, height: 64, borderRadius: 32 }}
    />
  )
}
