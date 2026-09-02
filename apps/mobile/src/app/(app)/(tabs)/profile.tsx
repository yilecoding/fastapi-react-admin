import { useRouter } from 'expo-router'
import * as React from 'react'
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Rail, RailAction, RailRow, RailSection } from '@/components/rail'
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
      className="bg-panel flex-1"
      contentContainerStyle={{ paddingTop: insets.top + 20 }}
      contentContainerClassName="px-6 pb-12"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <Pressable onPress={() => router.push('/profile/edit')} className="flex-row items-center gap-4">
        <Avatar url={user.avatar} fallback={user.nickname || user.username} />
        <View className="flex-1">
          <Text className="text-ink text-[22px] font-semibold" style={{ letterSpacing: -0.6 }} testID="profile-nickname">
            {user.nickname || user.username}
          </Text>
          <Text className="text-faint mt-1 font-mono text-[12px]">@{user.username}</Text>
        </View>
      </Pressable>

      {error ? (
        <View className="border-destructive/40 bg-destructive/10 mt-5 rounded-md border p-3">
          <Text className="text-ink text-sm">刷新失败：{error}</Text>
        </View>
      ) : null}

      <Rail className="mt-1">
        <RailSection label="资料" />
        <RailRow label="部门" value={user.dept} plain />
        <RailRow label="角色" value={user.roles.join('、')} plain />
        {/* 🔴 手机号和邮箱是**只读**的，不是漏做：
            - 手机号：后端**没有** `/me/phone`，只有超管能改（`PUT /sys/users/{pk}`）
            - 邮箱：`PUT /me/email` 要邮箱验证码，那条链路移动端还没有
            与其放一个改了会失败的输入框，不如把原因写在这儿。 */}
        <RailRow label="手机号" value={user.phone} note="需管理员修改" />
        <RailRow label="邮箱" value={user.email} note="改邮箱要邮件验证码" plain />
        <RailRow label="时区" value={user.timezone} />
        <RailRow label="账号" value={accountKind(user)} plain />
        <RailRow label="ID" value={user.id} />

        <RailSection label="账号操作" />
        <RailAction label="编辑资料" hint="昵称 · 头像" onPress={() => router.push('/profile/edit')} testID="profile-edit" />
        <RailAction label="修改密码" onPress={() => router.push('/profile/password')} testID="profile-password" />
        <RailAction label="退出登录" danger onPress={() => void logout()} testID="profile-logout" />
      </Rail>
    </ScrollView>
  )
}

function accountKind(user: { is_superuser: boolean; is_staff: boolean }) {
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}

function Avatar({ url, fallback }: { url: string | null; fallback: string }) {
  const [broken, setBroken] = React.useState(false)
  // 头像地址坏掉时 `Image` 默认渲染成一个**透明的洞**，看起来像布局塌了。
  // 回落到首字符，让「没有头像」和「头像挂了」都有一个确定的样子。
  if (!url || broken) {
    return (
      <View className="border-dim h-14 w-14 items-center justify-center rounded-md border">
        <Text className="text-ink text-xl font-semibold">{fallback.slice(0, 1).toUpperCase()}</Text>
      </View>
    )
  }
  return <Image source={{ uri: url }} onError={() => setBroken(true)} style={{ width: 56, height: 56, borderRadius: 6 }} />
}
