import { app, net, protocol } from "electron"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * 用自定义标准协议 `app://local/` 加载渲染层，而不是 `file://`。
 *
 * 为什么值得多写这几十行：`file://` 下 History API 是废的，TanStack Router 的
 * browser history 直接不能用，就得为桌面端切成 hash history —— 那是改 `apps/web`
 * 的路由配置，会连浏览器版一起改掉。用标准协议 + SPA 回退，`apps/web` 一行不用动。
 */

export const APP_SCHEME = "app"
export const APP_ORIGIN = `${APP_SCHEME}://local`

/**
 * ⚠️ 必须在 `app.whenReady()` **之前**调用，晚了直接抛。
 * standard 让它有正常的源和相对路径解析；secure 让它算作安全上下文
 * （crypto.subtle、Service Worker 这些才可用）。
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/** 渲染层产物根目录：打包后在 resources/renderer，开发预览时回落到 apps/web/dist */
export function rendererRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "renderer")
    : path.resolve(app.getAppPath(), "../web/dist")
}

export function registerAppProtocolHandler(): void {
  const root = rendererRoot()

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname)
    const target = path.join(root, rel)

    // 路径穿越防线。`app://local/../../../etc/passwd` 归一化后会跑出 root，
    // 这里必须挡住 —— 渲染层里任何一个能拼 URL 的地方都可能被利用。
    const resolved = path.resolve(target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return new Response("Forbidden", { status: 403 })
    }

    // 命中真实文件就直接流式返回
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return net.fetch(pathToFileURL(resolved).toString())
    }

    // SPA 回退：/users/123 这种前端路由在磁盘上没有对应文件，交给 index.html。
    // ⚠️ 只对「看起来像页面」的请求回退。带扩展名的资源没命中就该 404 ——
    // 否则一个拼错的 .js 路径会拿到 index.html 的 HTML，报错变成
    // 「Unexpected token '<'」，排查方向整个跑偏。
    if (path.extname(resolved)) {
      return new Response("Not Found", { status: 404 })
    }
    return net.fetch(pathToFileURL(path.join(root, "index.html")).toString())
  })
}
