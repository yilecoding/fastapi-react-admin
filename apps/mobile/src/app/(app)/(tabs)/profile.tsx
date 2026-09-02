import { useRouter } from 'expo-router'
import { ChevronRightIcon, KeyRoundIcon, LogOutIcon, SquarePenIcon } from 'lucide-react-native'
import * as React from 'react'
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BrandBackdrop } from '@/components/brand-backdrop'
import { Icon } from '@/components/ui/icon'
import { Eyebrow, Rule, SectionHead } from '@/components/ui/panel'
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
    <View className="bg-panel flex-1">
      <BrandBackdrop className="absolute top-0 right-0 left-0 h-64" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 20 }}
        contentContainerClassName="px-5 pb-12 gap-8"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <View className="flex-row items-center gap-4">
          <Avatar url={user.avatar} fallback={user.nickname || user.username} />
          <View className="flex-1 gap-1">
            <Text className="text-ink text-xl font-semibold" style={{ letterSpacing: -0.4 }} testID="profile-nickname">
              {user.nickname || user.username}
            </Text>
            <Text className="text-faint font-mono text-xs">@{user.username}</Text>
          </View>
        </View>

        {error ? (
          <View className="border-destructive/40 bg-destructive/10 rounded-xl border p-3">
            <Text className="text-ink text-sm">刷新失败：{error}</Text>
          </View>
        ) : null}

        <View className="gap-3">
          <SectionHead label="PROFILE" />
          <View>
            <Field label="部门" value={user.dept} />
            <Field label="角色" value={user.roles.join('、')} />
            {/* 🔴 手机号和邮箱是**只读**的，不是漏做：
                - 手机号：后端**没有** `/me/phone`，只有超管能改（`PUT /sys/users/{pk}`）
                - 邮箱：`PUT /me/email` 要邮箱验证码，那条链路移动端还没有
                与其放一个改了会失败的输入框，不如把原因写在这儿。 */}
            <Field label="手机号" value={user.phone} note="需管理员修改" />
            <Field label="邮箱" value={user.email} note="改邮箱要邮件验证码" />
            <Field label="时区" value={user.timezone} mono />
            <Field label="账号 ID" value={user.id} mono last />
          </View>
        </View>

        <View className="gap-3">
          <SectionHead label="ACCOUNT" />
          <View>
            <Action icon={SquarePenIcon} label="编辑资料" onPress={() => router.push('/profile/edit')} testID="profile-edit" />
            <Action icon={KeyRoundIcon} label="修改密码" onPress={() => router.push('/profile/password')} testID="profile-password" />
            <Action icon={LogOutIcon} label="退出登录" danger onPress={() => void logout()} testID="profile-logout" last />
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

/** 一行字段。左标签右值，底下一条发丝线 —— 没有卡片、没有背景块 */
function Field({
  label,
  value,
  note,
  mono,
  last,
}: {
  label: string
  value?: string | null
  note?: string
  mono?: boolean
  last?: boolean
}) {
  return (
    <View className={`flex-row items-start gap-4 py-3 ${last ? '' : 'border-line border-b'}`}>
      <Text className="text-faint w-20 shrink-0 text-sm">{label}</Text>
      <View className="flex-1 items-end gap-0.5">
        <Text
          className={`text-ink text-right text-sm ${mono ? 'font-mono text-xs' : ''}`}
          numberOfLines={2}
        >
          {value?.trim() ? value : '—'}
        </Text>
        {note ? <Text className="text-faint text-right text-xs">{note}</Text> : null}
      </View>
    </View>
  )
}

function Action({
  icon,
  label,
  onPress,
  danger,
  last,
  testID,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  label: string
  onPress: () => void
  danger?: boolean
  last?: boolean
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className={`active:bg-node flex-row items-center gap-3 py-3.5 ${last ? '' : 'border-line border-b'}`}
    >
      <Icon as={icon} className={`size-4 ${danger ? 'text-destructive' : 'text-faint'}`} />
      <Text className={`flex-1 text-sm ${danger ? 'text-destructive' : 'text-ink'}`}>{label}</Text>
      {danger ? null : <Icon as={ChevronRightIcon} className="text-faint size-3.5" />}
    </Pressable>
  )
}

function Avatar({ url, fallback }: { url: string | null; fallback: string }) {
  const [broken, setBroken] = React.useState(false)
  // 头像地址坏掉时 `Image` 默认渲染成一个**透明的洞**，看起来像布局塌了。
  // 回落到首字符，让「没有头像」和「头像挂了」都有一个确定的样子。
  if (!url || broken) {
    return (
      <View className="bg-node border-hair h-14 w-14 items-center justify-center rounded-2xl border">
        <Text className="text-ink text-xl font-semibold">{fallback.slice(0, 1).toUpperCase()}</Text>
      </View>
    )
  }
  return <Image source={{ uri: url }} onError={() => setBroken(true)} style={{ width: 56, height: 56, borderRadius: 16 }} />
}
