/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 构建标识。由 `vite.config.ts` 的 `buildIdPlugin` 在构建时注入
   * （开发期不注入，`lib/app-version.ts` 回落成 "dev"）。
   * 和 dist 根目录那份 `version.json` 里的 `buildId` 是同一个值 ——
   * 「服务端发新版了」就是靠这两个值不相等判出来的。
   */
  readonly VITE_BUILD_ID?: string
  /** 产品版本，来自 apps/web/package.json，构建和开发期都注入 */
  readonly VITE_APP_VERSION?: string

  /** 开发期显式设为 `true` 时挂载 TanStack Router Devtools，默认关闭。 */
  readonly VITE_ROUTER_DEVTOOLS?: string
}
