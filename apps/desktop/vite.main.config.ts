import { builtinModules } from "node:module"
import path from "node:path"
import { defineConfig } from "vite"

/**
 * 主进程构建。
 *
 * 为什么不用 electron-vite / vite-plugin-electron：
 * 这两个都假设「main / preload / renderer 在同一个 Vite 项目里」。而这里 renderer 是
 * `apps/web` 的产物，desktop 只负责 main + preload + 打包。硬套的第一件事就是把它们的
 * 结构拆掉，那还不如直接写两个 lib 模式的 config —— 一共不到 40 行，没有魔法，
 * 也不会被插件对 Vite 大版本的跟进速度卡住（electron-vite 稳定版至今 peer 只到 vite 7，
 * 而本仓库是 vite 8）。
 */
export default defineConfig({
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    target: "esnext",
    // 主进程报错要能对上源码行号，体积无所谓，所以不压缩
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/main/index.ts"),
      // 必须是 cjs：preload 在 sandbox 下只能是 CommonJS，主进程跟着统一，
      // 省掉 dist 里再放一个 `{"type":"commonjs"}` 的 package.json
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: [
        "electron",
        // electron-updater 保持外置：它内部有按 provider 的惰性 require，
        // 打进 bundle 容易在运行时才炸。它在 dependencies 里，由 electron-builder 一起打包
        "electron-updater",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
  resolve: {
    alias: {
      "@admin/platform": path.resolve(import.meta.dirname, "../../packages/platform/src"),
    },
  },
})
