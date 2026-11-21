import * as React from 'react'
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native'

import { ServerForm } from '@/components/server-form'

/**
 * 服务器地址设置（已登录，从设置屏进）。表单本体在 `components/server-form.tsx`，
 * 登录屏上未登录时用的是同一份（#406）。保存成功会登出 → 这棵树整棵卸载、回到登录屏
 */
export default function ServerScreen() {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="bg-background flex-1"
    >
      <ScrollView contentContainerClassName="py-4" keyboardShouldPersistTaps="handled">
        <ServerForm />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
