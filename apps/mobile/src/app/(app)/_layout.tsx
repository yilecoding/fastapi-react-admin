import { Stack } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { useCSSVariable } from 'uniwind'

import { NoticePopups } from '@/components/notice-popups'

/**
 * 已登录那棵树的**外层 Stack**。
 *
 * 🔴 **tabs 必须套在一层 Stack 里，不能让 `(app)` 直接是 Tabs。**
 * 否则「通知」「编辑资料」这种不该占 tab 位的屏没地方放 ——
 * `(app)/` 下每多一个文件就自动多一个 tab。用 `href: null` 藏得掉，
 * 但那样它仍在 tab 导航器内，**没有返回键、标题也要自己接**。
 *
 * 现在的形状：Stack 里第一屏是 `(tabs)`（自己不出 header），
 * 其余屏推在 tab 之上，天然带返回键、盖住 tab 栏 —— 这是移动端的常规做法。
 */
export default function AppLayout() {
  const { t } = useTranslation()
  const bg = useCSSVariable('--color-background')
  const fg = useCSSVariable('--color-foreground')
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

  return (
    <>
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: 'minimal',
          /*
           * 导航头和页面**同一个底色**、没有分隔线、标题居中 —— iOS 分组列表的导航栏就是这样，
           * 分组块自己的白底已经把层级说清楚了。
           *
           * ⚠️ 原来是「卡片白 + 发丝线」，用意是和页面的淡紫底分开，实测效果是一条白带压着
           * 一片紫，两块颜色硬拼；标题又默认靠左（Material），和三个 tab 屏的大标题不是一套。
           */
          headerStyle: { backgroundColor: str(bg) },
          headerTintColor: str(fg),
          headerTitleAlign: 'center',
          headerTitleStyle: { fontSize: 17, fontWeight: '600', color: str(fg) },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: str(bg) },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ title: t('通知') }} />
        <Stack.Screen name="settings" options={{ title: t('设置') }} />
        <Stack.Screen name="server" options={{ title: t('服务器地址') }} />
        <Stack.Screen name="timezone" options={{ title: t('显示时区') }} />
        <Stack.Screen name="profile/info" options={{ title: t('个人资料') }} />
        <Stack.Screen name="profile/edit" options={{ title: t('编辑资料') }} />
        <Stack.Screen name="profile/password" options={{ title: t('修改密码') }} />
        <Stack.Screen name="profile/phone" options={{ title: t('手机号') }} />
        <Stack.Screen name="users/index" options={{ title: t('用户') }} />
        {/* ⚠️ 动态段的 `name` 用的是**文件名**（`users/[id]`），不是拼好的路径 */}
        <Stack.Screen name="users/[id]" options={{ title: t('用户详情') }} />
        <Stack.Screen name="notices/[id]" options={{ title: t('公告详情') }} />
        <Stack.Screen name="workflow/index" options={{ title: t('审批') }} />
        <Stack.Screen name="workflow/[id]" options={{ title: t('审批详情') }} />
        <Stack.Screen name="workflow/start/index" options={{ title: t('发起审批') }} />
        <Stack.Screen name="workflow/start/[code]" options={{ title: t('发起审批') }} />
      </Stack>
      {/*
        登录后弹窗（#190）。挂在这里 = 「外壳挂上之后」：这棵树只在已登录时存在（根 `_layout` 的 AuthGate），
        冷启动恢复会话、刚登录完都从这里开始；登出时整棵卸载，弹窗跟着没。
        它渲染进根布局的 `<PortalHost />`，所以放在 Stack 旁边、盖在任何一屏之上
      */}
      <NoticePopups />
    </>
  )
}
