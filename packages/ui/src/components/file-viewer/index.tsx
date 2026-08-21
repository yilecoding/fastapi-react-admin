import { lazy, Suspense } from "react"
import type { FileViewerToolbarPosition } from "@file-viewer/core"
import type { FileViewerHandle } from "@file-viewer/react"
import { cn } from "@admin/ui/lib/utils"
import { Skeleton } from "@admin/ui/components/skeleton"

/**
 * 文件预览器外壳（零业务）。
 *
 * 真正干活的是第三方包 `@file-viewer/*`（Flyfish File Viewer，Apache-2.0）——
 * pdf / docx / xlsx / 图片 / 文本 / 压缩包各有一个 renderer，自带工具栏
 * （搜索 · 缩放 · 旋转 · 页面缩略图 · 下载 · 打印 · 明暗切换）。
 *
 * 三条硬约束，改这个文件前务必读完：
 *
 * 1. **必须 `lazy()`**。renderer 加起来是 MB 级的，静态 import 会把它们
 *    拖进入口 chunk，然后被登录页的 modulepreload 提前下载。
 *    实测 lazy 之后入口 chunk 里 file-viewer / pdfjs 命中数是 0。
 *
 * 2. **喂 `buffer` 而不是 `url`**。字节由调用方用 api-client 取（带 JWT），
 *    viewer 只负责渲染。这样就不需要「Redis 票据 + 短时效公开 URL」那一套——
 *    后端也不再有无鉴权直链可给。
 *    ⚠️ 例外：音视频要 Range 拖进度，整块 ArrayBuffer 拖不动，那类得走真实 URL。
 *
 * 3. **只在可见处挂载**（放 Dialog / Sheet 里，别常驻页面）。
 *    多页签用 `<Activity>` 保活，隐藏 tab 是 `display:none` → 宽度 0，
 *    而 renderer 要测容器尺寸（CLAUDE.md 里 recharts 已经栽过同一个坑）。
 *    真要在隐藏处挂，可在转可见时调 `handle.fitToView()` 补救。
 *
 * 另外：它渲染在 **Shadow DOM** 里（`.file-viewer-web-shell`）。
 * 好处是样式与 Tailwind 天然隔离；代价是 `document.querySelector` 穿不进去，
 * 写 E2E 要用 Playwright 自己的 locator（它会自动穿透 shadow）。
 */
// ⚠️ 必须 import 本地的 `./viewer`，**不能**直接 import "@file-viewer/react"。
// renderer 的注册在 ./viewer 里，只有走这条路径它们才会跟着一起进懒加载分片；
// 直接 import 官方包会得到一个「没有任何 renderer」的 viewer —— 任何文件都渲染不出来。
const Viewer = lazy(() => import("./viewer").then((m) => ({ default: m.FileViewer })))

export type FileViewerProps = {
  /** 文件字节。由调用方带鉴权取回 */
  buffer: ArrayBuffer
  /** 带扩展名的文件名 —— renderer 靠它选谁来渲染，**不能省** */
  filename: string
  className?: string
  ref?: React.Ref<FileViewerHandle | null>
}

/** 底部自带工具条的格式 —— 浮动工具栏要让开 */
const BOTTOM_OCCUPIED = new Set(["xlsx", "xls", "csv"])

/**
 * 浮动工具栏放哪儿。
 *
 * 默认右下：顶部横条会占掉一整行高度，而预览弹窗的纵向空间本来就紧张。
 *
 * 但表格类**底部有工作表页签**（Sheet1/Sheet2…），右下会把它压住 ——
 * 实测 xlsx 预览里 `Print` 被裁成 `…rt`，页签条也盖掉一半。
 * 这类改到顶部居中：表格渲染器自己没有顶部栏，那一条是空的。
 *
 * ⚠️ 取值只能是 `FileViewerToolbarPosition` 的四个之一
 * （`auto` / `top` / `top-center` / `bottom-right`）。写别的不会报错、
 * 运行时静默回落到默认位置 —— 看起来「生效了」，其实是巧合（`top-right` 踩过）。
 */
function toolbarPosition(filename: string): FileViewerToolbarPosition {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return BOTTOM_OCCUPIED.has(ext) ? "top-center" : "bottom-right"
}

export function FileViewer({ buffer, filename, className, ref }: FileViewerProps) {
  return (
    <Suspense fallback={<Skeleton className="size-full" />}>
      <Viewer
        ref={ref}
        buffer={buffer}
        filename={filename}
        className={cn("size-full", className)}
        options={{
          toolbar: { position: toolbarPosition(filename), exportHtml: false },
        }}
      />
    </Suspense>
  )
}

export type { FileViewerHandle }
