import { useRouter } from 'expo-router'
import { ChevronRightIcon, KeyRoundIcon, LogOutIcon, SquarePenIcon } from 'lucide-react-native'
import * as React from 'react'
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Icon } from '@/components/ui/icon'
import { Card, Divider, Row, Section } from '@/components/ui/panel'
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
      contentContainerStyle={{ paddingTop: insets.top + 12 }}
      contentContainerClassName="gap-6 px-4 pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      {/* 身份卡 —— 头像得有个「家」。上一版它是一块白方块浮在辉光上，没有归属 */}
      <Card className="mt-1">
        <Pressable
          onPress={() => router.push('/profile/edit')}
          className="active:bg-panel flex-row items-center gap-4 p-4"
        >
          <Avatar url={user.avatar} fallback={user.nickname || user.username} />
          <View className="flex-1 gap-1">
            <Text className="text-ink text-[19px] font-semibold" style={{ letterSpacing: -0.3 }} testID="profile-nickname">
              {user.nickname || user.username}
            </Text>
            <Text className="text-faint font-mono text-xs">@{user.username}</Text>
          </View>
          <Icon as={ChevronRightIcon} className="text-faint size-4" />
        </Pressable>
      </Card>

      {error ? (
        <View className="border-destructive/40 bg-destructive/10 rounded-2xl border p-3.5">
          <Text className="text-ink text-sm">刷新失败：{error}</Text>
        </View>
      ) : null}

      <Section label="资料">
        <Field label="部门" value={user.dept} />
        <Field label="角色" value={user.roles.join('、')} />
        {/* 🔴 手机号和邮箱是**只读**的，不是漏做：
            - 手机号：后端**没有** `/me/phone`，只有超管能改（`PUT /sys/users/{pk}`）
            - 邮箱：`PUT /me/email` 要邮箱验证码，那条链路移动端还没有
            与其放一个改了会失败的输入框，不如把原因写在这儿。 */}
        <Field label="手机号" value={user.phone} note="需管理员修改" />
        <Field label="邮箱" value={user.email} note="改邮箱要邮件验证码" />
        <Field label="时区" value={user.timezone} mono />
        <Field label="账号" value={accountKind(user)} last />
      </Section>

      <Section label="账号">
        <Action icon={SquarePenIcon} label="编辑资料" onPress={() => router.push('/profile/edit')} testID="profile-edit" />
        <Action icon={KeyRoundIcon} label="修改密码" onPress={() => router.push('/profile/password')} testID="profile-password" last />
      </Section>

      {/* 登出单独一张卡 —— 和上面那两个动作分开，它不是同一量级的操作 */}
      <Card>
        <Pressable
          onPress={() => void logout()}
          testID="profile-logout"
          className="active:bg-panel min-h-[52px] flex-row items-center justify-center gap-2"
        >
          <Icon as={LogOutIcon} className="text-destructive size-4" />
          <Text className="text-destructive text-[15px] font-medium">退出登录</Text>
        </Pressable>
      </Card>

      <Text className="text-faint text-center font-mono text-[10px]" style={{ letterSpacing: 1.2 }}>
        {user.id}
      </Text>
    </ScrollView>
  )
}

function accountKind(user: { is_superuser: boolean; is_staff: boolean }) {
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}

/** 一行只读字段：左标签右值。**值是重的那一边**，标签退到 faint */
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
    <>
      <View className="min-h-[52px] flex-row items-center gap-4 px-4 py-3">
        <Text className="text-faint shrink-0 text-[15px]">{label}</Text>
        <View className="flex-1 items-end">
          <Text className={`text-ink text-right text-[15px] ${mono ? 'font-mono text-[13px]' : ''}`} numberOfLines={2}>
            {value?.trim() ? value : '—'}
          </Text>
          {note ? <Text className="text-faint mt-0.5 text-right text-xs">{note}</Text> : null}
        </View>
      </View>
      {last ? null : <Divider />}
    </>
  )
}

function Action({
  icon,
  label,
  onPress,
  last,
  testID,
}: {
  icon: React.ComponentProps<typeof Icon>['as']
  label: string
  onPress: () => void
  last?: boolean
  testID?: string
}) {
  return (
    <>
      <Pressable
        onPress={onPress}
        testID={testID}
        className="active:bg-panel min-h-[52px] flex-row items-center gap-3 px-4 py-3"
      >
        <Icon as={icon} className="text-faint size-4" />
        <Text className="text-ink flex-1 text-[15px]">{label}</Text>
        <Icon as={ChevronRightIcon} className="text-faint size-4" />
      </Pressable>
      {last ? null : <Divider />}
    </>
  )
}

function Avatar({ url, fallback }: { url: string | null; fallback: string }) {
  const [broken, setBroken] = React.useState(false)
  // 头像地址坏掉时 `Image` 默认渲染成一个**透明的洞**，看起来像布局塌了。
  // 回落到首字符，让「没有头像」和「头像挂了」都有一个确定的样子。
  if (!url || broken) {
    return (
      <View className="bg-panel border-hair h-12 w-12 items-center justify-center rounded-full border">
        <Text className="text-dim text-lg font-semibold">{fallback.slice(0, 1).toUpperCase()}</Text>
      </View>
    )
  }
  return <Image source={{ uri: url }} onError={() => setBroken(true)} style={{ width: 48, height: 48, borderRadius: 24 }} />
}
