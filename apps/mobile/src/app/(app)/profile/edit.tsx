import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Group, Row } from '@/components/grouped'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { api } from '@/lib/api'
import { parseFieldErrors, type FieldErrors } from '@/lib/field-errors'
import { useSession } from '@/lib/session'

export default function EditProfileScreen() {
  const { t } = useTranslation()
  const { user, reload } = useSession()
  const router = useRouter()
  const [nickname, setNickname] = React.useState(user?.nickname ?? '')
  const [avatar, setAvatar] = React.useState(user?.avatar ?? '')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /*
   * 🔴 **字段级错误只在后端是 dev 时才有**（生产的 422 信封里 `data` 是 `null`，
   * `msg` 也不带字段名）—— 所以 `error` 那一条**始终要渲染**，
   * 不能因为「有 fieldErrors 了」就把它藏掉。细节见 `lib/field-errors.ts`。
   */
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({})

  if (!user) return null

  const nicknameChanged = nickname.trim() !== user.nickname
  const avatarChanged = avatar.trim() !== (user.avatar ?? '')
  const dirty = nicknameChanged || avatarChanged

  async function save() {
    if (saving || !user) return
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      // 两个字段是**两个独立的接口**，后端没有一个「改我的资料」的合并口。
      // 只发改过的那个：全都发的话，没动的字段也会写一遍，头像那条尤其危险（见下）。
      if (nicknameChanged) {
        await api.PUT('/api/v1/sys/users/me/nickname', { body: { nickname: nickname.trim() } })
      }
      if (avatarChanged) {
        // 🔴 空串要发 `null`，**不能发 `''`**。
        // 读取侧 `GetUserInfoDetail.avatar` 是 `HttpUrl | None`，存进空串之后
        // 登录和 `/users/me` 会全部 422（`url_parsing: input is empty`）——
        // 连改坏它的人自己都登不回来。后端注释里记了这次实测。
        await api.PUT('/api/v1/sys/users/me/avatar', { body: { avatar: avatar.trim() || null } })
      }
      await reload()
      // 🔴 先回退再报成功 —— 这一屏马上要卸载，屏内提示等于没提示
      router.back()
      toast.success(t('资料已保存'))
    } catch (err) {
      // ⚠️ 这里**不用** toast：屏没有卸载、错误有位置可占，而且字段错误必须
      // 贴在对应那一格上。toast 只管「屏要走了」的那种失败（见 `ui/toast.tsx`）
      const parsed = parseFieldErrors(err)
      setError(parsed.general)
      setFieldErrors(parsed.fields)
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="bg-background flex-1">
      <ScrollView contentContainerClassName="gap-4 py-4" keyboardShouldPersistTaps="handled">
        <Group>
          <Row first>
            <Text className="w-[70px] shrink-0 text-[15px]">{t('昵称')}</Text>
            <Input
              value={nickname}
              onChangeText={(v) => {
                setNickname(v)
                // 改了就把这一格的错误清掉 —— 留着的话用户改对了还红着，
                // 会以为「改了也没用」
                if (fieldErrors.nickname) setFieldErrors((p) => ({ ...p, nickname: '' }))
              }}
              testID="edit-nickname"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
            />
          </Row>
          <FieldError message={fieldErrors.nickname} testID="edit-nickname-error" />
          <Row>
            <Text className="w-[70px] shrink-0 text-[15px]">{t('头像')}</Text>
            <Input
              value={avatar}
              onChangeText={(v) => {
                setAvatar(v)
                if (fieldErrors.avatar) setFieldErrors((p) => ({ ...p, avatar: '' }))
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://"
              testID="edit-avatar"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
            />
          </Row>
          <FieldError message={fieldErrors.avatar} testID="edit-avatar-error" />
        </Group>

        <Text className="text-muted-foreground px-5 text-xs leading-5">
          {t('头像留空表示清除。暂时只能填 URL —— 从相册选图要 expo-image-picker + 文件上传接口，还没接。')}
        </Text>

        {error ? (
          <Text className="text-destructive px-5 text-sm" testID="edit-error">
            {error}
          </Text>
        ) : null}

        <View className="px-4 pt-1">
          <Button
            disabled={!dirty || saving}
            onPress={() => void save()}
            testID="edit-save"
            className="h-[50px] rounded-xl"
          >
            {saving ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text className="text-base font-semibold">{saving ? t('保存中') : t('保存')}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/**
 * 贴在某一格下面的错误。
 *
 * ⚠️ 它在 `Group` **里面**、紧跟那一行 —— 放到 Group 外面的话，
 * 三个字段的错误会堆在整块下方，又得靠读文案猜是哪一格。
 */
function FieldError({ message, testID }: { message?: string; testID?: string }) {
  if (!message) return null
  return (
    <Text className="text-destructive px-5 pb-2 text-xs leading-4" testID={testID}>
      {message}
    </Text>
  )
}
