import { RouterProvider } from "@tanstack/react-router"
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { t } from "@admin/i18n"
import { ApiError } from "@admin/platform/api-client/errors"
import { setSessionExpiredHandler } from "@admin/platform/api-client/client"
import { installVersionWatch } from "@/lib/app-version"
import { useApplyPreferences } from "@admin/platform/shell/use-apply-preferences"
import { toast, Toaster } from "@admin/ui/components/toast"
import { createAppRouter } from "@/router"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
  // 硬纪律 9 的「写入型」姊妹：mutation 失败必须可见，但不能靠每个调用处各自
  // 记得写 toast。这里是唯一兜底：任何 mutation 失败都弹一条 toast，除非调用处
  // 显式声明 `meta: { suppressErrorToast: true }`。两类调用处会声明这个标记：
  //   - 表单校验（create/update）：已经把错误内联展示在字段旁边，再弹一条一样的 toast 只是噪音
  //   - 单条删除确认框：失败要留在弹窗里说清楚原因、原地重试（流派一），不是关了弹窗
  //     再靠这条全局 toast 兜底——见各 `pages/*/index.tsx` 删除确认框的 onConfirm
  // 走到这里报错的主要是**批量删除**（allSettled 的部分失败没法「原地重试」，
  // 弹窗照旧关掉）和极少数没加内联处理的调用处
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.suppressErrorToast) return
      // 401 已经在 setSessionExpiredHandler 里跳登录页了，弹一条会在路由切换的
      // 瞬间被冲掉，纯属噪音
      if (error instanceof ApiError && error.isUnauthorized) return
      // 后端已经把消息翻译好了（ApiError.message）；不是 ApiError 时
      // 多半是调用处自己 throw 的摘要（如「2 / 5 项删除失败」），message 也有意义
      //
      // ⚠️ 这里显式给了 6s 超时，没有沿用 toast 组件里「error 默认不自动消失」
      // 的约定——那条约定是给「页面上还有别的错误态、toast 只是补充」的场景写的
      // （见 packages/ui/src/components/toast.tsx 头注释）。批量删除失败时弹窗已经
      // 关掉、不留错误文案，这条 toast 是唯一的可见状态，如果也不自动消失，
      // 用户每次都要多点一次「×」才能继续操作，是这条链路独有的摩擦，
      // 不代表要改那条组件级默认值
      toast.error(error instanceof Error ? error.message : t("操作失败"), { timeout: 6000 })
    },
  }),
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
