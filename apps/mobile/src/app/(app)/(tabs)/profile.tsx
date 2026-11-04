import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import {
  ChevronRightIcon,
  KeyRoundIcon,
  SettingsIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from 'lucide-react-native'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { BrandTop } from '@/components/brand-top'
import { Chevron, DangerRow, Group, GroupHeader, PressRow, RowIcon } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Text } from '@/components/ui/text'
import { useSession } from '@/lib/session'

export default function ProfileScreen() {
  const { t } = useTranslation()
  const { user, reload, logout } = useSession()
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /*
   * 🔴 退出登录**要确认**。这一行原来是 `onPress={() => void logout()}` ——
   * 点到就走，而它在个人中心最底部、正是拇指划到底时容易蹭到的位置。
   * 移动端在 `ui/confirm-dialog.tsx` 之前**没有任何确认框**，所以这类
   * 破坏性动作一律是「点了就发生」。
   */
  const [confirmingLogout, setConfirmingLogout] = React.useState(false)

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
        <Pressable onPress={() => router.push('/profile/info')} testID="profile-header" className="flex-row items-center gap-3.5 pt-1">
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

      {/*
        「我的」首屏只放入口：资料从顶部卡片进 `profile/info.tsx`，编辑在资料页右上角（同微信）。
        原来这里直接铺着部门 / 角色 / 邮箱 / 时区 / 账号 ID —— 账号 ID 是雪花 ID，对用户毫无用处。
      */}
      <GroupHeader>{t('安全')}</GroupHeader>
      <Group>
        {/* 手机号（#224）：右边写明验证状态 —— 管理员录入的号没验证过，验证码登录不认 */}
        <PressRow first inset={56} onPress={() => router.push('/profile/phone')} testID="profile-phone">
          <RowIcon icon={SmartphoneIcon} />
          <Text className="flex-1 text-[15px]">{t('手机号')}</Text>
          <Text
            className={`text-[13px] ${user.phone && !user.phone_verified_time ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}
          >
            {!user.phone ? t('未绑定') : user.phone_verified_time ? t('已验证') : t('未验证')}
          </Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
        <PressRow inset={56} onPress={() => router.push('/profile/password')} testID="profile-password">
          <RowIcon icon={KeyRoundIcon} />
          <Text className="flex-1 text-[15px]">{t('修改密码')}</Text>
          <Chevron icon={ChevronRightIcon} />
        </PressRow>
      </Group>

      <View className="pt-4">
        <Group>
          <PressRow first inset={56} onPress={() => router.push('/settings')} testID="profile-settings">
            <RowIcon icon={SettingsIcon} />
            <Text className="flex-1 text-[15px]">{t('设置')}</Text>
            <Text className="text-muted-foreground text-[13px]">{t('外观 · 时区 · 服务器')}</Text>
            <Chevron icon={ChevronRightIcon} />
          </PressRow>
        </Group>
      </View>

      {/* 登出单独一个分组块 —— iOS 上「破坏性动作」就是这么放的 */}
      <View className="pt-4">
        <Group>
          <DangerRow label={t('退出登录')} onPress={() => setConfirmingLogout(true)} testID="profile-logout" />
        </Group>
      </View>

      <ConfirmDialog
        open={confirmingLogout}
        onOpenChange={setConfirmingLogout}
        title={t('退出登录')}
        description={t('下次进来要重新输入账号密码。')}
        confirmLabel={t('退出')}
        cancelLabel={t('取消')}
        onConfirm={() => {
          setConfirmingLogout(false)
          void logout()
        }}
        testID="logout-confirm"
      />
    </ScrollView>
  )
}

/** ⚠️ 返回 **key**，由调用处 `t()` */
function accountKind(user: { is_superuser: boolean; is_staff: boolean }) {
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}
