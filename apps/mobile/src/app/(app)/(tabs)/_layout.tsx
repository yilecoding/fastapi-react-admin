import { StyleSheet } from 'react-native'

import { Tabs } from 'expo-router'
import { HomeIcon, LayoutGridIcon, UserRoundIcon } from 'lucide-react-native'
import { useCSSVariable } from 'uniwind'

import { Icon } from '@/components/ui/icon'
import { useUnread } from '@/lib/notifications'

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/**
 * 已登录那棵树的导航壳：**底部三个 tab**（issue #39「要拍的三件事」第 3 条已定）。
 *
 * ⚠️ `Tabs` 靠 `@react-navigation/bottom-tabs`，它**不在** Expo Go 自带模块清单里 ——
 * 但那是纯 JS 包，装了就能用，**不需要 prebuild**（那条豁免还在，见本分册
 * 「Expo Go 还能用」一节）。
 *
 * 🔴 **这个目录下每多一个文件就会自动多一个 tab。**
 * 不该当 tab 的屏（通知、编辑资料、修改密码）放在**外面那层 Stack** 里
 * （`(app)/_layout.tsx`），推在 tab 之上 —— 天然带返回键、盖住 tab 栏。
 *
 * 三个屏都关掉了 Tabs 自己的 header：它们各自有品牌头或自定义的筛选条，
 * 再叠一条系统标题栏会很挤。
 */
export default function AppLayout() {
  const primary = useCSSVariable('--color-primary')
  const muted = useCSSVariable('--color-muted-foreground')
  const { unread } = useUnread()
  const card = useCSSVariable('--color-card')
  const bg = useCSSVariable('--color-background')
  const line = useCSSVariable('--color-border')

  return (
    <Tabs
      screenOptions={{
        tabBarHideOnKeyboard: true,
        // 选中态用品牌主色。**颜色只能从令牌取**，不能在这里写死一个 hex ——
        // react-navigation 的 tabBar 是原生组件，不吃 className，
        // 而写死之后深浅色主题里必然有一头是错的。
        tabBarActiveTintColor: str(primary),
        tabBarInactiveTintColor: str(muted),
        // tab 栏要和内容区的「浅底」区分开，否则中间是一道生硬的接缝。
        // 顶边用 hairlineWidth 而不是 1 —— 1px 在高密度屏上是两三个物理像素，很重。
        // iOS 的 tab 栏比页面底稍亮一点（浅色）/ 稍暗一点（深色），
        // 靠 card 色 + 发丝顶边和内容区分开。**不能留系统默认白** ——
        // 那和 grouped background 之间会有一道生硬的接缝
        tabBarStyle: {
          backgroundColor: str(card),
          borderTopColor: str(line),
          borderTopWidth: StyleSheet.hairlineWidth,
          elevation: 0,
        },
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '首页',
          headerShown: false,
          tabBarIcon: ({ color }) => <Icon as={HomeIcon} color={color} />,
        }}
      />
      <Tabs.Screen
        name="apps"
        options={{
          title: '应用',
          headerShown: false,
          tabBarIcon: ({ color }) => <Icon as={LayoutGridIcon} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          headerShown: false,
          // 未读数挂在「我的」上 —— 通知的入口在首页快捷入口里，
          // 而红点要在任何一个 tab 上都看得见，挂最右边那个最不打扰
          tabBarBadge: unread && unread.total > 0 ? unread.total : undefined,
          tabBarIcon: ({ color }) => <Icon as={UserRoundIcon} color={color} />,
        }}
      />
    </Tabs>
  )
}
