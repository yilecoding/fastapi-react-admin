import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Group, Row } from '@/components/grouped'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { api } from '@/lib/api'
import { parseFieldErrors, type FieldErrors } from '@/lib/field-errors'
import { useSession } from '@/lib/session'

export default function ChangePasswordScreen() {
  const { t } = useTranslation()
  const { logout } = useSession()
  const [oldPassword, setOldPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // ⚠️ 生产环境下这个一定是空的（后端只在 dev 下发 `loc`），所以 `error`
  // 那一条必须照旧渲染。见 `lib/field-errors.ts`
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({})
  const [done, setDone] = React.useState(false)

  const mismatch = confirm.length > 0 && newPassword !== confirm
  const canSubmit = oldPassword.length > 0 && newPassword.length > 0 && !mismatch && !saving && !done

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      await api.PUT('/api/v1/sys/users/me/password', {
        body: { old_password: oldPassword, new_password: newPassword, confirm_password: confirm },
      })
      // 🔴 改密成功之后**这个会话已经死了**：`user_service.update_password` 会
      // `delete_by_prefix` 掉该用户的 access / refresh / 用户缓存三组 key。
      // 不主动收场的话，用户会在下一个请求 401 时被莫名其妙弹回登录页 ——
      // 看起来像 bug，其实是预期行为。所以这里明说一句再登出。
      setDone(true)
    } catch (err) {
      // 后端的强度/历史密码校验也走 422，所以「新密码太弱」能贴到那一格上
      const parsed = parseFieldErrors(err)
      setError(parsed.general)
      setFieldErrors(parsed.fields)
    } finally {
      setSaving(false)
    }
  }

  if (done) {
    return (
      <View className="bg-background flex-1 justify-center gap-5 px-6">
        
        <Text className="text-foreground text-2xl font-semibold" style={{ letterSpacing: -0.6 }}>
          {t('密码已修改')}
        </Text>
        <Text className="text-muted-foreground text-sm leading-6">
          {t('服务端已经作废了当前会话，这是后端的既定行为，不是出错。请用新密码重新登录。')}
        </Text>
        <Button size="lg" onPress={() => void logout()} testID="password-relogin">
          <Text>{t('去重新登录')}</Text>
        </Button>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="bg-background flex-1">
      <ScrollView contentContainerClassName="gap-4 py-4" keyboardShouldPersistTaps="handled">
        <Group>
          <PwRow
            first
            label={t('当前密码')}
            value={oldPassword}
            onChange={setOldPassword}
            error={fieldErrors.old_password}
            testID="password-old"
          />
          <PwRow
            label={t('新密码')}
            value={newPassword}
            onChange={setNewPassword}
            error={fieldErrors.new_password}
            testID="password-new"
          />
          <PwRow
            label={t('确认')}
            value={confirm}
            onChange={setConfirm}
            error={fieldErrors.confirm_password}
            testID="password-confirm"
          />
        </Group>

        <Text className="text-muted-foreground px-5 text-xs leading-5">
          {t('服务端有强度与历史密码校验，不合格会在提交时告诉你。')}
        </Text>

        {mismatch ? <Text className="text-destructive px-5 text-sm">{t('两次输入的新密码不一致')}</Text> : null}
        {error ? (
          <Text className="text-destructive px-5 text-sm" testID="password-error">
            {error}
          </Text>
        ) : null}

        <View className="px-4 pt-1">
          <Button
            disabled={!canSubmit}
            onPress={() => void submit()}
            testID="password-submit"
            className="h-[50px] rounded-xl"
          >
            {saving ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text className="text-base font-semibold">{saving ? t('提交中') : t('确认修改')}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function PwRow({
  first,
  label,
  value,
  onChange,
  error,
  testID,
}: {
  first?: boolean
  label: string
  value: string
  onChange: (v: string) => void
  /** 该字段的 422 错误。只在后端是 dev 时才拿得到 */
  error?: string
  testID: string
}) {
  return (
    <>
      <Row first={first}>
        <Text className="min-w-[76px] shrink-0 text-[15px]">{label}</Text>
        <Input
          value={value}
          onChangeText={onChange}
          secureTextEntry
          testID={testID}
          className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none"
        />
      </Row>
      {error ? (
        <Text className="text-destructive px-5 pb-2 text-xs leading-4" testID={`${testID}-error`}>
          {error}
        </Text>
      ) : null}
    </>
  )
}
