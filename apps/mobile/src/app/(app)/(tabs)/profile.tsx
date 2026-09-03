import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ChevronRightIcon, KeyRoundIcon, SettingsIcon, SquarePenIcon, TriangleAlertIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { BrandTop } from '@/components/brand-top'
import { Chevron, DangerRow, Group, GroupHeader, PressRow, Row, RowIcon } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Text } from '@/components/ui/text'
import { useSession } from '@/lib/session'

export default function ProfileScreen() {
  const { t } = useTranslation()
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
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <BrandTop>
        <Pressable onPress={() => router.push('/profile/edit')} className="flex-row items-center gap-3.5 pt-1">
          <Avatar alt={user.nickname || user.username} className="size-[54px] rounded-[17px]">
            {/* 头像地址坏掉时 AvatarImage 静默不显示，AvatarFallback 兜住 ——
                「没有头像」和「头像挂了」都有一个确定的样子 */}
            {user.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
            <AvatarFallback className="bg-primary rounded-[17px]">
              <Text className="text-primary-foreground text-xl font-semibold">
                {(user.nickname || user.username).slice(0, 1).toUpperCase()}
              </Text>
            </AvatarFallback>
          </Avatar>
          <View className="flex-1 gap-0.5">
            <Text className="text-lg font-semibold" testID="profile-nickname">
              {user.nickname || user.username}
            </Text>
            <Text className="text-muted-foreground font-mono text-xs">
              @{user.username} · {t(accountKind(user))}
            </Text>
          </View>
          <Chevron icon={ChevronRightIcon} />
        </Pressable>
      </BrandTop>

      {error ? (
        <View className="px-4 pt-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('刷新失败')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </View>
      ) : null}

      <GroupHeader>{t('资料')}</GroupHeader>
      <Group>
        <Field first label={t('部门')} value={user.dept} />
        <Field label={t('角色')} value={user.roles.join('、')} />
        {/* 🔴 手机号和邮箱是**只读**的，不是漏做：
            - 手机号：后端**没有** `/me/phone`，只有超管能改（`PUT /sys/users/{pk}`）
            - 邮箱：`PUT /me/email` 要邮箱验证码，那条链路移动端还没有
            与其放一个改了会失败的输入框，不如把原因写在这儿。 */}
        <Field label={t('手机号')} value={user.phone} note={t('需管理员修改')} />
        <Field label={t('邮箱')} value={user.email} note={t('改邮箱要邮件验证码')} />
        <Field label={t('时区')} value={user.timezone} mono />
        {/* ⚠️ schema 里 `id` 是 `string | number`（后端那个 `field_serializer` 的
            声明就是 `-> str | int`），wire 上实际总是字符串。这里只是展示，
            就地 `String()` —— **不要 `Number()`**（硬纪律 6：会丢精度） */}
        <Field label={t('账号 ID')} value={String(user.id)} mono />
      </Group>

      <GroupHeader>{t('账号')}</GroupHeader>
      <Group>
        <PressRow first inset={56} onPress={() => router.push('/profile/edit')} testID="profile-edit">
          <RowIcon icon={SquarePenIcon} />
          <Text className="flex-1 text-[15px]">{t('编辑资料')}</Text>
          <Text className="text-muted-foreground text-[13px]">{t('昵称 · 头像')}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
        <PressRow inset={56} onPress={() => router.push('/profile/password')} testID="profile-password">
          <RowIcon icon={KeyRoundIcon} />
          <Text className="flex-1 text-[15px]">{t('修改密码')}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
        <PressRow inset={56} onPress={() => router.push('/settings')} testID="profile-settings">
          <RowIcon icon={SettingsIcon} />
          <Text className="flex-1 text-[15px]">{t('设置')}</Text>
          <Text className="text-muted-foreground text-[13px]">{t('外观 · 时区 · 服务器')}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>

      {/* 登出单独一个分组块 —— iOS 上「破坏性动作」就是这么放的 */}
      <View className="pt-4">
        <Group>
          <DangerRow label={t('退出登录')} onPress={() => void logout()} testID="profile-logout" />
        </Group>
      </View>
    </ScrollView>
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
  note,
  mono,
}: {
  first?: boolean
  label: string
  value?: string | null
  note?: string
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
        {note ? <Text className="text-muted-foreground/70 mt-0.5 text-right text-[11px]">{note}</Text> : null}
      </View>
    </Row>
  )
}
