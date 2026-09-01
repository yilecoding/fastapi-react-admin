import { Stack } from 'expo-router'

/**
 * 已登录那棵树的导航壳 —— **刻意做成最小的一个 Stack**。
 *
 * issue #39「要拍的三件事」第 3 条（导航形态：底部 tab / 抽屉 / 栈怎么组合）
 * 还没拍，所以这里不预设。**换形态时只动这一个文件**：把 `Stack` 换成
 * `Tabs`（`expo-router` 的 `Tabs`，需要额外装 `@react-navigation/bottom-tabs`，
 * 它**不在** Expo Go 自带模块清单里，但那是纯 JS 包，装了就能用），
 * 下面那些屏一行都不用改 —— 它们只是文件路由里的叶子。
 */
export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: '我的' }} />
      <Stack.Screen name="edit-profile" options={{ title: '编辑资料', presentation: 'modal' }} />
      <Stack.Screen name="change-password" options={{ title: '修改密码', presentation: 'modal' }} />
    </Stack>
  )
}
