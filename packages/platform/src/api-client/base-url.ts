/**
 * 渲染层的后端地址从哪来（#392）。
 *
 * - 浏览器：编译期的 `VITE_API_BASE`。生产同源部署时它是空串（请求走相对路径），
 *   所以只在 `undefined` 时回落开发地址 —— 用 `??` 不用 `||`。
 * - 桌面端：**运行期**的 `config.json` 的 `serverUrl`（preload 同步取来挂在 `window.desktop.serverUrl`），
 *   和主进程 `auth.ts` 登录 / 刷新读的是同一份，两边才是同一个后端。
 *
 * 🔴 修之前桌面端也走编译期那条：release 构建 `VITE_API_BASE=''` → 业务请求全打到
 * `app://local/api/v1/...`，协议处理器对无扩展名路径回 `index.html`，验证码拿到 200 + HTML。
 * 开发模式回落到 8088 能用，所以一直没暴露。
 *
 * 桌面端没配地址时返回空串**不回落开发地址**：登录页据此显示「填写服务器地址」，
 * 而不是悄悄连一个装机用户那台机器上根本不存在的 127.0.0.1:8088。
 * 配了但不是完整的 HTTP(S) 基址（手改 config.json 漏了协议之类）同样当没配 ——
 * 不带协议的值会被 fetch 按 `app://local` 解析，又回到上面那个症状。
 */
import { serverBaseUrl } from '../desktop/http-url'

export const DEV_API_BASE = 'http://127.0.0.1:8088'

export function resolveApiBase(env: string | undefined, bridge: { serverUrl?: string } | null): string {
  if (bridge && typeof bridge.serverUrl === 'string') return serverBaseUrl(bridge.serverUrl) ?? ''
  return env ?? DEV_API_BASE
}
