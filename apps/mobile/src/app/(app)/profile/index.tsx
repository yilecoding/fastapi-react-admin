import { useRouter } from 'expo-router'
import * as React from 'react'
import { Image, RefreshControl, ScrollView, View } from 'react-native'

import { ReadonlyRow } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Text } from '@/components/ui/text'
import { useSession } from '@/lib/session'

export default function ProfileScreen() {
  const { user, reload, logout } = useSession()
  const router = useRouter()
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
      contentContainerClassName="gap-6 p-4 pb-16"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <View className="flex-row items-center gap-4">
        <Avatar url={user.avatar} fallback={user.nickname || user.username} />
        <View className="flex-1 gap-0.5">
          <Text className="text-foreground text-xl font-semibold" testID="profile-nickname">
            {user.nickname || user.username}
          </Text>
          <Text className="text-muted-foreground text-sm">@{user.username}</Text>
        </View>
      </View>

      {error ? (
        <View className="border-destructive/40 bg-destructive/10 rounded-md border p-3">
          <Text className="text-foreground text-sm">刷新失败：{error}</Text>
        </View>
      ) : null}

      <View>
        <ReadonlyRow label="部门" value={user.dept} />
        <ReadonlyRow label="角色" value={user.roles.join('、')} />
        {/* 🔴 手机号和邮箱在这里是**只读**的，不是漏做：
            - 手机号：后端**没有** `/me/phone` 这个口，只有超管能改（`PUT /sys/users/{pk}`）
            - 邮箱：`PUT /me/email` 要一个**邮箱验证码**，那条链路移动端还没有
            与其放一个改了会 403 / 缺参数的输入框，不如把原因写在这儿。 */}
        <ReadonlyRow label="手机号" value={user.phone} hint="需要管理员修改" />
        <ReadonlyRow label="邮箱" value={user.email} hint="改邮箱要邮件验证码，暂未支持" />
        <ReadonlyRow label="时区" value={user.timezone} />
        <ReadonlyRow label="账号类型" value={user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'} />
      </View>

      <View className="gap-3">
        <Button variant="outline" onPress={() => router.push('/profile/edit')} testID="profile-edit">
          <Text>编辑资料</Text>
        </Button>
        <Button variant="outline" onPress={() => router.push('/profile/password')} testID="profile-password">
          <Text>修改密码</Text>
        </Button>
        <Button variant="destructive" onPress={() => void logout()} testID="profile-logout">
          <Text>退出登录</Text>
        </Button>
      </View>
    </ScrollView>
  )
}

function Avatar({ url, fallback }: { url: string | null; fallback: string }) {
  const [broken, setBroken] = React.useState(false)
  // 头像地址坏掉时 `Image` 默认渲染成一个**透明的洞**，看起来像布局塌了。
  // 回落到首字符，让「没有头像」和「头像挂了」都有一个确定的样子。
  if (!url || broken) {
    return (
      <View className="bg-muted h-16 w-16 items-center justify-center rounded-full">
        <Text className="text-muted-foreground text-xl font-semibold">{fallback.slice(0, 1).toUpperCase()}</Text>
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
