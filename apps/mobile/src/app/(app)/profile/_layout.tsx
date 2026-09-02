import { Stack } from 'expo-router'

/** 「我的」这个 tab 内部的栈 —— 编辑资料 / 修改密码是它的子屏，不是 tab */
export default function ProfileLayout() {
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: '我的' }} />
      <Stack.Screen name="edit" options={{ title: '编辑资料' }} />
      <Stack.Screen name="password" options={{ title: '修改密码' }} />
    </Stack>
  )
}
