import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Group, Row } from '@/components/grouped'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { api } from '@/lib/api'
import { pickAvatar, uploadAvatar } from '@/lib/avatar'
import { parseFieldErrors, type FieldErrors } from '@/lib/field-errors'
import { usePerm } from '@/lib/perm'
import { useSession } from '@/lib/session'

export default function EditProfileScreen() {
  const { t } = useTranslation()
  const { user, reload } = useSession()
  const router = useRouter()
  const [nickname, setNickname] = React.useState(user?.nickname ?? '')
  const [avatar, setAvatar] = React.useState(user?.avatar ?? '')
  const [saving, setSaving] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const perm = usePerm()
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

  /*
   * 选图即上传、上传即生效 —— 不等「保存」按钮。和 web 个人中心同一个口径：
   * 文件已经落到服务器上了，再让用户点一次保存只会多出「传了但没存」这种中间态。
   */
  async function upload() {
    if (uploading || saving) return
    const asset = await pickAvatar()
    if (!asset) return
    setUploading(true)
    try {
      const url = await uploadAvatar(asset)
      await reload()
      // 地址框跟着换成新地址，否则 `avatarChanged` 为真、保存按钮亮着，像是还有没存的改动
      setAvatar(url)
      toast.success(t('头像已更新'))
    } catch (err) {
      toast.error(t('头像上传失败'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setUploading(false)
    }
  }

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
          <Row first className="gap-3.5 py-3">
            <Avatar alt={user.nickname || user.username} className="size-[54px] rounded-[17px]">
              {user.avatar ? <AvatarImage source={{ uri: user.avatar }} /> : null}
              <AvatarFallback className="bg-primary rounded-[17px]">
                <Text className="text-primary-foreground text-xl font-semibold">
                  {(user.nickname || user.username).slice(0, 1).toUpperCase()}
                </Text>
              </AvatarFallback>
            </Avatar>
            <View className="flex-1 items-start gap-1">
              {/*
               * 🔴 上传接口挂着 `sys:file:upload`，而且是 POST —— 还要过 `is_staff` 那道闸
               * （见 `lib/perm.ts`），所以用 `canWrite` 不是 `can`。没权限时**说出来**，
               * 不要让按钮静默消失：那样用户只会以为移动端不支持传头像（硬纪律 9）。
               * 权限码没问到（`known` 为假）时也不显示按钮，免得点了必然 403 —— 但要说清是
               * 「还在问」还是「问失败了」，后者不能停在一句永远转不完的「正在确认」。
               */}
              {perm.canWrite('sys:file:upload') ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={uploading || saving}
                  onPress={() => void upload()}
                  testID="edit-avatar-pick"
                >
                  {uploading ? <ActivityIndicator size="small" /> : null}
                  <Text>{uploading ? t('上传中…') : t('从相册选择')}</Text>
                </Button>
              ) : (
                <Text className="text-muted-foreground text-xs leading-5" testID="edit-avatar-no-perm">
                  {perm.known
                    ? t('你没有上传文件的权限，只能在下面填图片地址')
                    : perm.error
                      ? t('没能确认上传权限：{{reason}}', { reason: perm.error })
                      : t('正在确认上传权限…')}
                </Text>
              )}
            </View>
          </Row>
        </Group>

        <Group>
          <Row first>
            <Text className="min-w-[70px] shrink-0 text-[15px]">{t('昵称')}</Text>
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
            <Text className="min-w-[70px] shrink-0 text-[15px]">{t('头像')}</Text>
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
          {t('头像地址留空表示清除；也可以直接粘贴一个已有的图片地址。')}
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
