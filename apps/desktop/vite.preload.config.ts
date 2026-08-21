import { builtinModules } from "node:module"
import path from "node:path"
import { defineConfig } from "vite"

/**
 * preload 构建。
 *
 * ⚠️ 必须输出 CommonJS。窗口开了 `sandbox: true`，而沙箱化的 preload **只能**是
 * CommonJS 脚本 —— 给它一个 ESM 文件，Electron 会静默加载失败，
 * 表现是渲染层里 `window.desktop` 是 undefined，而控制台不一定有明确报错。
 */
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    target: "esnext",
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
  },
  resolve: {
    alias: {
      "@admin/platform": path.resolve(import.meta.dirname, "../../packages/platform/src"),
    },
  },
})
