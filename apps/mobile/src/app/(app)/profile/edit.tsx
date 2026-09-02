import { useRouter } from 'expo-router'
import * as React from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Group, Row } from '@/components/grouped'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

export default function EditProfileScreen() {
  const { user, reload } = useSession()
  const router = useRouter()
  const [nickname, setNickname] = React.useState(user?.nickname ?? '')
  const [avatar, setAvatar] = React.useState(user?.avatar ?? '')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (!user) return null

  const nicknameChanged = nickname.trim() !== user.nickname
  const avatarChanged = avatar.trim() !== (user.avatar ?? '')
  const dirty = nicknameChanged || avatarChanged

  async function save() {
    if (saving || !user) return
    setSaving(true)
    setError(null)
    try {
      // 两个字段是**两个独立的接口**，后端没有一个「改我的资料」的合并口。
      // 只发改过的那个：全都发的话，没动的字段也会写一遍，头像那条尤其危险（见下）。
      if (nicknameChanged) {
        await api.PUT('/api/v1/sys/users/me/nickname', { nickname: nickname.trim() })
      }
      if (avatarChanged) {
        // 🔴 空串要发 `null`，**不能发 `''`**。
        // 读取侧 `GetUserInfoDetail.avatar` 是 `HttpUrl | None`，存进空串之后
        // 登录和 `/users/me` 会全部 422（`url_parsing: input is empty`）——
        // 连改坏它的人自己都登不回来。后端注释里记了这次实测。
        await api.PUT('/api/v1/sys/users/me/avatar', { avatar: avatar.trim() || null })
      }
      await reload()
      router.back()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="bg-background flex-1">
      <ScrollView contentContainerClassName="gap-4 py-4" keyboardShouldPersistTaps="handled">
        <Group>
          <Row first>
            <Text className="w-[70px] shrink-0 text-[15px]">昵称</Text>
            <Input
              value={nickname}
              onChangeText={setNickname}
              testID="edit-nickname"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
            />
          </Row>
          <Row>
            <Text className="w-[70px] shrink-0 text-[15px]">头像</Text>
            <Input
              value={avatar}
              onChangeText={setAvatar}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://"
              testID="edit-avatar"
              className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
            />
          </Row>
        </Group>

        <Text className="text-muted-foreground px-5 text-xs leading-5">
          头像留空表示清除。暂时只能填 URL —— 从相册选图要 expo-image-picker + 文件上传接口，还没接。
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
            <Text className="text-base font-semibold">{saving ? '保存中' : '保存'}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
