import {
  registerFileViewerAutoRendererPreset,
  resolveFileViewerRuntimeAssetBaseUrl,
  setDefaultFileViewerAssetBaseUrl,
} from "@file-viewer/core"
import { archiveRenderer } from "@file-viewer/renderer-archive"
import { imageRenderer } from "@file-viewer/renderer-image"
import { mediaRenderer } from "@file-viewer/renderer-media"
import { pdfRenderer } from "@file-viewer/renderer-pdf"
import { pptxRenderer } from "@file-viewer/renderer-pptx"
import { spreadsheetRenderer } from "@file-viewer/renderer-spreadsheet"
import { textRenderer } from "@file-viewer/renderer-text"
import { wordRenderer } from "@file-viewer/renderer-word"

/**
 * 🔴 资源根目录要自己设 —— 这是 `inject: false` 的另一半代价。
 *
 * pdf.worker、libarchive 的 worker/wasm 这些资产由插件的 copyAssets 发布在
 * `dist/file-viewer/` 下（`vite.config.ts` 的 `baseDir`），但 renderer 去哪儿取，
 * 3.x 起是插件**注入的那段运行时代码**调 `setDefaultFileViewerAssetBaseUrl` 告诉它的。
 * 关了注入就没人调，renderer 回落到站点根目录取 `/vendor/pdf/pdf.worker.mjs` → 404。
 *
 * 失败方式不显眼：PDF 照样能看（退回主线程跑 PDF.js，控制台只有一条 warning），
 * 压缩包只剩 ZIP/TAR 兜底，界面上一行小字说 libarchive 起不来 —— rar / 7z 打不开。
 * 实测 2.x 升 3.2 时两处同时出现。
 *
 * 写法照抄插件生成的那段（按部署根目录拼，不按当前页面的路径拼）。
 * `"file-viewer"` 必须和 `vite.config.ts` 的 `copyAssets.baseDir` 一致。
 */
const deploymentBase = resolveFileViewerRuntimeAssetBaseUrl(document)
setDefaultFileViewerAssetBaseUrl(
  new URL("file-viewer", deploymentBase.endsWith("/") ? deploymentBase : `${deploymentBase}/`).href
)

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
 *
 * ⚠️ 一律用**具名**导入。`@file-viewer/renderer-pptx` 的默认导出是渲染函数
 * `renderPptx`，不是插件 —— 其余几个包的默认导出才恰好是插件。
 */
registerFileViewerAutoRendererPreset(
  [
    pdfRenderer,
    wordRenderer,
    spreadsheetRenderer,
    pptxRenderer,
    imageRenderer,
    textRenderer,
    archiveRenderer,
    mediaRenderer,
  ],
  // 固定 id：热更新时重复执行会替换而不是叠加注册
  { id: "tenon-file-viewer" }
)

export { FileViewer } from "@file-viewer/react"
