import { RouterProvider } from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { setSessionExpiredHandler } from "@admin/platform/api-client/client"
import { installVersionWatch } from "@/lib/app-version"
import { useApplyPreferences } from "@admin/platform/shell/use-apply-preferences"
import { Toaster } from "@admin/ui/components/toast"
import { createAppRouter } from "@/router"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
})

const router = createAppRouter(queryClient)

// 401 且刷新失败 → 清空服务端状态缓存并跳登录页
setSessionExpiredHandler(() => {
  queryClient.clear()
  void router.navigate({ to: "/sign-in", search: { redirect: undefined } })
})

// 「服务端发新版了，请刷新」——多页签保活鼓励用户长时间不刷新，
// 这条检测是它的配套（见 lib/app-version.ts）。装在模块级而不是组件里：
// 它和 React 生命周期无关，也不该因为 StrictMode 的双跑装两次
installVersionWatch()

export function App() {
  // 挂在这里而不是 PlatformProvider 里：那个只包登录后的外壳，
  // 挂那儿登录页就不跟随主题（深浅色 / 主题色 / 圆角全都不跟）
  useApplyPreferences()

  return (
    <QueryClientProvider client={queryClient}>
      {/* Toaster 包在最外层：非组件代码（mutation / api-client）也能弹提示 */}
      <Toaster>
        <RouterProvider router={router} />
      </Toaster>
    </QueryClientProvider>
  )
}
