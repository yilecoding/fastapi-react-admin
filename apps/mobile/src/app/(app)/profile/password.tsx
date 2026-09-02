import * as React from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Text } from '@/components/ui/text'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

export default function ChangePasswordScreen() {
  const { logout } = useSession()
  const [oldPassword, setOldPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)

  const mismatch = confirm.length > 0 && newPassword !== confirm
  const canSubmit = oldPassword.length > 0 && newPassword.length > 0 && !mismatch && !saving && !done

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      await api.PUT('/api/v1/sys/users/me/password', {
        old_password: oldPassword,
        new_password: newPassword,
        confirm_password: confirm,
      })
      // 🔴 改密成功之后**这个会话已经死了**：`user_service.update_password` 会
      // `delete_by_prefix` 掉该用户的 access / refresh / 用户缓存三组 key。
      // 不主动收场的话，用户会在下一个请求 401 时被莫名其妙弹回登录页 ——
      // 看起来像 bug，其实是预期行为。所以这里明说一句再登出。
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (done) {
    return (
      <View className="bg-background flex-1 justify-center gap-5 px-6">
        
        <Text className="text-foreground text-2xl font-semibold" style={{ letterSpacing: -0.6 }}>
          密码已修改
        </Text>
        <Text className="text-muted-foreground text-sm leading-6">
          服务端已经作废了当前会话，这是后端的既定行为，不是出错。请用新密码重新登录。
        </Text>
        <Button size="lg" onPress={() => void logout()} testID="password-relogin">
          <Text>去重新登录</Text>
        </Button>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="bg-background flex-1">
      <ScrollView contentContainerClassName="gap-7 px-6 py-7" keyboardShouldPersistTaps="handled">
        <View className="gap-2">
          <Label>当前密码</Label>
          <Input value={oldPassword} onChangeText={setOldPassword} secureTextEntry testID="password-old" />
        </View>
        <View className="gap-2">
          <Label>新密码</Label>
          <Input value={newPassword} onChangeText={setNewPassword} secureTextEntry testID="password-new" />
          <Text className="text-muted-foreground text-xs">服务端有强度与历史密码校验，不合格会在提交时告诉你</Text>
        </View>
        <View className="gap-2">
          <Label>确认新密码</Label>
          <Input value={confirm} onChangeText={setConfirm} secureTextEntry testID="password-confirm" />
        </View>

        {mismatch ? <Text className="text-destructive text-sm">两次输入的新密码不一致</Text> : null}
        {error ? (
          <Text className="text-destructive text-sm" testID="password-error">
            {error}
          </Text>
        ) : null}

        <Button size="lg" disabled={!canSubmit} onPress={() => void submit()} testID="password-submit">
          {saving ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Text>{saving ? '提交中' : '确认修改'}</Text>
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
