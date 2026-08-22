import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { fileViewerRenderers } from "@file-viewer/vite-plugin"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react" }),
    react(),
    tailwindcss(),
    // 文件预览器（@file-viewer）。这个插件不是可选项 —— 它干两件缺一不可的事：
    //   1. copyAssets：把 pdf.worker.mjs / cmaps / 字体发布到固定公共路径。
    //      不发布的话 pdf.js 会去取 /file-viewer/vendor/pdf/pdf.worker.mjs 拿到 404，
    //      界面上是「viewer 外壳正常、正文空白 + Setting up fake worker failed」——
    //      看起来像加载慢，其实是坏的（实测踩过）
    // ⚠️ `inject` 必须是 **false**。设 true 会把「注册 renderer」的虚拟模块注入
    // HTML 入口、进入静态依赖图，于是 Vite 给每个 renderer 发一条 modulepreload ——
    // 实测登录页预下载约 2.5MB（pdf 1.16MB + spreadsheet 628KB + archive 250KB + …），
    // 而多数会话根本不会打开预览。注册改由
    // packages/ui/src/components/file-viewer/viewer.tsx 在懒加载分片里手动做。
    //
    // renderers 只列中后台附件真正需要的。**不要**换成 preset-all / *-full 包：
    // 那会把 drawio(66MB) · typst(37MB) · cad(20MB) · iwork 全拷进 dist，
    // 实测 dist 从 60MB 涨到 186MB，而且在插件里 narrow formats 是**无效**的
    // （-full 包静态依赖 preset-all，整个 renderer 图已经在模块图里）。
    fileViewerRenderers({
      renderers: ["pdf", "word", "spreadsheet", "image", "text", "archive"],
      autoPresets: false,
      copyAssets: { baseDir: "file-viewer" },
      inject: false,
      // 也必须是 "none"。默认的 "renderer" 会按渲染器分组建 chunk，
      // 而共享依赖（JSZip / libarchive 那些）会被塞进
      // `file-viewer-archive` 分片里 —— 入口只要用到其中一个共享符号，
      // 就得把整个 250KB 分片一起拉进来并 modulepreload。
      // 交给 rolldown 自己分片，入口就只静态 import 一个 4KB runtime（实测）。
      chunkStrategy: "none",
    }),
  ],
  // 端口固定在 1125。`strictPort` 是关键：不写它 Vite 会在端口被占时自己 +1 漂到
  // 1126，而后端 CORS 白名单和 oauth2 回跳地址都是写死 1125 的 —— 漂走之后表现是
  // 「页面能开，但所有接口 CORS 失败」，比直接起不来难查得多。
  //
  // `E2E_WEB_PORT` 是唯一的例外口子：E2E 起的是完全隔离的第二个实例（连 fba_test，
  // 不是 fba），不设置这个变量时行为和以前完全一样，还是 1125。
  server: {
    port: Number(process.env.E2E_WEB_PORT) || 1125,
    strictPort: true,
    proxy: {
      // 富文本正文里的内联图走这里。后端把它挂成静态资源
      // （registrar.py 的 `/uploads` → PUBLIC_UPLOAD_DIR）。
      //
      // 🔴 这条代理是**必须**的，而且必须让存进库的 src 保持**相对路径**：
      // 正文是 HTML，里面是 `<img src="/uploads/2026/…/x.png">`。
      // 不加代理的话相对地址会打到 Vite（:1125）拿 404；
      // 而改成绝对地址就等于把 `http://127.0.0.1:8000` 烙进 sys_notice.content ——
      // 每一篇在开发机上写的公告都会带着这个 host，换环境全部裂掉。
      //
      // 生产环境前后端同域，相对地址天然可用，这条代理只在 dev 需要。
      "/uploads": {
        target: process.env.VITE_API_BASE ?? "http://127.0.0.1:8000",
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@admin/platform": path.resolve(import.meta.dirname, "../../packages/platform/src"),
      // 多语言包（新的最底层，ui/platform/web 都从它取）
      "@admin/i18n": path.resolve(import.meta.dirname, "../../packages/i18n/src/index.ts"),
    },
  },
})
