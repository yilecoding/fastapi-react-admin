import { registerFileViewerAutoRendererPreset } from "@file-viewer/core"
import archiveRenderer from "@file-viewer/renderer-archive"
import imageRenderer from "@file-viewer/renderer-image"
import pdfRenderer from "@file-viewer/renderer-pdf"
import spreadsheetRenderer from "@file-viewer/renderer-spreadsheet"
import textRenderer from "@file-viewer/renderer-text"
import wordRenderer from "@file-viewer/renderer-word"

/**
 * 渲染器注册 + `FileViewer` 再导出。
 *
 * **这个文件的存在只有一个目的：把 renderer 关在懒加载分片里。**
 *
 * 本来可以让 `@file-viewer/vite-plugin` 的 `inject: true` 自动注册，
 * 但那样注册模块会被注入 HTML 入口、进入**静态**依赖图，
 * Vite 于是给每个 renderer 发一条 `<link rel="modulepreload">` ——
 * 实测登录页就会预下载 pdf(1.16MB) + spreadsheet(628KB) + archive(250KB)
 * + word + image + text，约 2.5MB，而绝大多数会话根本不会打开预览。
 *
 * 所以插件那边设 `inject: false`（只留 copyAssets 发布 wasm/worker 资产），
 * 注册改成在这里手动做。只要调用方用 `lazy(() => import('./viewer'))`，
 * renderer 就只在真正打开预览时才下载。
 *
 * ⚠️ 增删 renderer 要动**三处**，少一处就会出错：
 *   1. 这里的 import + 数组
 *   2. `apps/web/vite.config.ts` 的 `renderers`（决定 copyAssets 发布哪些资产）
 *   3. `platform/pages/file/api.ts` 的 `PREVIEWABLE`（决定界面上哪些能点预览）
 */
registerFileViewerAutoRendererPreset(
  [pdfRenderer, wordRenderer, spreadsheetRenderer, imageRenderer, textRenderer, archiveRenderer],
  // 固定 id：热更新时重复执行会替换而不是叠加注册
  { id: "tenon-file-viewer" }
)

export { FileViewer } from "@file-viewer/react"
