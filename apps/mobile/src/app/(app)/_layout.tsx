import { Tabs } from 'expo-router'
import { HomeIcon, LayoutGridIcon, UserRoundIcon } from 'lucide-react-native'

import { Icon } from '@/components/ui/icon'

/**
 * 已登录那棵树的导航壳：**底部三个 tab**（issue #39「要拍的三件事」第 3 条已定）。
 *
 * ⚠️ `Tabs` 靠 `@react-navigation/bottom-tabs`，它**不在** Expo Go 自带模块清单里 ——
 * 但那是纯 JS 包，装了就能用，**不需要 prebuild**（那条豁免还在，见本分册
 * 「Expo Go 还能用」一节）。
 *
 * 🔴 **这个目录下每多一个文件就会自动多一个 tab。**
 * 不该当 tab 的屏（编辑资料、修改密码）放进**子目录 + 自己的 Stack**
 * ——`profile/` 就是这么做的。另一种写法是 `options={{ href: null }}` 把它藏掉，
 * 但那样返回键和标题都要自己接，而嵌套 Stack 天然就对。
 *
 * 「个人中心」这个 tab 关掉了 Tabs 自己的 header（`headerShown: false`），
 * 因为它下面那层 Stack 已经出了一个 —— 不关会**叠两条标题栏**。
 */
export default function AppLayout() {
  return (
    <Tabs screenOptions={{ tabBarHideOnKeyboard: true }}>
      <Tabs.Screen
        name="index"
        options={{
          title: '首页',
          tabBarIcon: ({ color }) => <Icon as={HomeIcon} color={color} />,
        }}
      />
      <Tabs.Screen
        name="apps"
        options={{
          title: '应用',
          tabBarIcon: ({ color }) => <Icon as={LayoutGridIcon} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          headerShown: false,
          tabBarIcon: ({ color }) => <Icon as={UserRoundIcon} color={color} />,
        }}
      />
    </Tabs>
  )
}
