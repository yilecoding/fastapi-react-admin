import { t } from "@admin/i18n"
import { toast } from "@admin/ui/components/toast"

/**
 * 「服务端发新版了」的检测。
 *
 * ## 为什么需要它
 *
 * 这个项目的卖点是多页签保活 —— 用户被鼓励**长时间开着一堆 tab 不刷新**。
 * 而 `apps/web/nginx.conf` 那套缓存防护（`/assets/` 永久缓存 + `index.html`
 * `no-store`）解决的是「**下一次**加载拿到的是配套的壳子和 chunk」，它对
 * 一个已经开了一天没刷新的页面**什么都做不了**。那个页面上：
 *
 * - 后端接口做了破坏性变更（哪怕只是加了个必填字段），旧前端拿到不认识的结构
 * - 点到懒加载分片（文件预览那条链是真的 `lazy(() => import('./viewer'))`），
 *   而那个 hash 文件已经被新构建覆盖删除 → `import()` 直接 404
 *
 * 两种都表现成「一个说不清原因的报错」，而用户不知道**刷新一下就好了**。
 *
 * ## 两条检测，同一个出口
 *
 * | 路径 | 触发时机 | 覆盖面 |
 * |---|---|---|
 * | `version.json` 轮询 | 切回这个标签页 / 每 10 分钟 | 全部（包括「旧前端 + 新后端」这种没有任何前端报错的情形） |
 * | 懒加载失败特征 | 真的取不到分片时 | 精准，但只覆盖动态 import |
 *
 * 🔴 **只做第二条是不够的**，尽管它更便宜：这个仓库**几乎没有路由级代码分割**
 * （`lib/page-registry.tsx` 把每个页面都静态 import 进主 bundle），全仓
 * 只有 file-viewer 一条真的懒加载链。也就是说「点到已删除的 chunk」这个
 * 触发点很窄，而「旧前端配新后端」那个更常见的场景根本不产生前端错误 ——
 * 没有轮询就完全检测不到。
 */

/**
 * 构建标识。生产由 vite 在构建时注入（见 `vite.config.ts` 的 `buildIdPlugin`），
 * 开发期是字面量 `dev`。
 */
export const BUILD_ID: string = import.meta.env.VITE_BUILD_ID ?? "dev"

/** 轮询间隔：管理后台是长时间挂着的页面，10 分钟一次足够，也不打扰 */
const POLL_MS = 10 * 60_000
/** 「切回标签页就查一次」的最小间隔 —— 频繁切窗口不该变成频繁请求 */
const FOCUS_THROTTLE_MS = 60_000

/**
 * 是不是「分片取不到」类错误。
 *
 * 特征串取自浏览器实际抛出的文案（Chrome / Firefox / Safari 各不相同），
 * 所以是一组而不是一条。⚠️ 判**过宽**的代价是把普通网络错误说成「发新版了」，
 * 所以只认这几条明确和模块加载相关的，不要放宽到 `Failed to fetch`。
 */
export function isStaleAssetError(error: unknown): boolean {
  const msg =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : ""
  if (!msg) return false
  return [
    "Failed to fetch dynamically imported module", // Chrome
    "error loading dynamically imported module", // Firefox
    "Importing a module script failed", // Safari
    "ChunkLoadError", // 打包器自己包装过的
    "Loading chunk", // 同上（webpack 风格文案，留着不亏）
  ].some((needle) => msg.includes(needle))
}

let notified = false

/**
 * 提示一次就够。**不自动刷新** —— 中后台的用户可能正在填一张长表单，
 * 替他刷新等于把没提交的东西扔了。给一个按钮，什么时候刷由他定。
 */
export function notifyNewVersion() {
  if (notified) return
  notified = true
  toast.warning(t("已发布新版本"), {
    description: t("当前页面用的还是旧版前端，刷新后继续使用。"),
    // 0 = 不自动消失：这条自己溜走就等于没提示
    timeout: 0,
    action: { label: t("刷新"), onClick: () => window.location.reload() },
  })
}

async function fetchBuildId(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" })
    if (!res.ok) return null
    // 开发期没有这个文件，vite 可能回落成 index.html（HTML 进不了 JSON.parse）——
    // 拿不到就当「这个环境没有版本信息」，静默跳过，不要报错也不要提示
    const body = (await res.json()) as { buildId?: unknown }
    return typeof body.buildId === "string" ? body.buildId : null
  } catch {
    return null
  }
}

/**
 * 装上两条检测。返回卸载函数（应用根一直挂着，实际不会调用，留着便于测试）。
 */
export function installVersionWatch(): () => void {
  let lastCheck = 0
  let timer: number | undefined

  const check = async () => {
    if (notified) return
    lastCheck = Date.now()
    const served = await fetchBuildId()
    if (served && served !== BUILD_ID) notifyNewVersion()
  }

  const onWake = () => {
    if (document.visibilityState !== "visible") return
    if (Date.now() - lastCheck < FOCUS_THROTTLE_MS) return
    void check()
  }

  const onRejection = (e: PromiseRejectionEvent) => {
    if (isStaleAssetError(e.reason)) notifyNewVersion()
  }

  const onError = (e: ErrorEvent) => {
    if (isStaleAssetError(e.error ?? e.message)) notifyNewVersion()
  }

  void check()
  timer = window.setInterval(() => void check(), POLL_MS)
  document.addEventListener("visibilitychange", onWake)
  window.addEventListener("focus", onWake)
  window.addEventListener("unhandledrejection", onRejection)
  window.addEventListener("error", onError)

  return () => {
    if (timer !== undefined) window.clearInterval(timer)
    document.removeEventListener("visibilitychange", onWake)
    window.removeEventListener("focus", onWake)
    window.removeEventListener("unhandledrejection", onRejection)
    window.removeEventListener("error", onError)
  }
}
