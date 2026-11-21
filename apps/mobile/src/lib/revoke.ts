import { confirmsLogout } from '@admin/api'

import { api } from '@/lib/api'
import { logoutPending } from '@/lib/logout-pending'
import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

/**
 * 登出 / 换服务器时「让服务端作废当前会话」这一段（从 `session.tsx` 拆出来，好在 Node 里单测，#406）。
 * React 状态（`applyAnonymous` / `endReason`）仍在 `SessionProvider` 里。
 */

/** 登出撤销的超时。登录屏要等它，所以宁短勿长；没确认的下次冷启动还会补发 */
const REVOKE_TIMEOUT_MS = 8_000

/**
 * 让服务端把当前服务器上的这个会话作废（#138 之后一个会话就是一个 key）。确认了就删「待撤销」标记，
 * 没确认（网络 / 5xx / 429）就留着，下次冷启动再补发。
 *
 * 401 / 403 也算确认（`confirmsLogout`）。后端的登出接口对「没有凭据」是幂等成功，
 * 只带 cookie（没有 access token）也认得出会话 —— 所以调用方可以先清本地、再在后台发它。
 *
 * ⚠️ **后台发，不要 await 在界面前面**：服务器不可达时 RN 的 fetch 自己要等 10～60 秒才失败，
 * 点了「退出」没反应 / 冷启动卡在闪屏上。
 *
 * 🔴 **但它要有超时**（`REVOKE_TIMEOUT_MS`，#374）：登录前 `settleRevoke()` 要等它落地，没有超时的话
 * 离线登出之后马上登录会卡同样的 10～60 秒。超时 = 没确认，标记留着、下次冷启动补发。
 * 掐断之后这次请求的响应就不会再到，也就不会晚于新登录去清 cookie —— 那正是 `settleRevoke` 要防的。
 * 手写 `AbortController` + `setTimeout`：Hermes 没有 `AbortSignal.timeout()`。
 */
async function revokeOnServer(base: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS)
  try {
    // 🔴 同步发出：`send` 在第一个 await 之前就取了地址，见 `startRevoke`
    await api.POST('/api/v1/auth/logout', { signal: controller.signal })
  } catch (err) {
    if (!confirmsLogout(err)) return
  } finally {
    clearTimeout(timer)
  }
  await logoutPending.remove(base)
}

/** 后台那次撤销，连同它打向哪台服务器。登录前要等它落地，见 `startRevoke` */
let revoking: { base: string; done: Promise<void> } | null = null

/**
 * 🔴 **登录前要等上一次撤销落地**：登出响应会带一条清空 refresh cookie 的 `Set-Cookie`。
 * 它要是晚于新登录的响应到达，cookie jar 里**新**会话的 refresh cookie 就被清掉了 ——
 * 新登录照常进去，半小时后 access token 到期、刷新失败，被莫名其妙踢回登录屏
 */
export function startRevoke(): void {
  // 🔴 同步调用：`revokeOnServer` 在第一个 await 之前就读了地址、发出了请求 —— 换服务器紧接着
  // 就改地址（`switchServer`），这里要是先 await 一下，登出就打到新服务器上去了
  const base = serverStore.current()
  const done = revokeOnServer(base).finally(() => {
    if (revoking?.done === done) revoking = null
  })
  revoking = { base, done }
}

/**
 * 登录前调用。🔴 **只等打向当前这台服务器的那次撤销**（#406）：cookie jar 按主机分，
 * 旧服务器的登出响应清不到新服务器的 cookie，没有可防的竞态。原来无条件等 ——
 * 旧服务器连不上（正是要换服务器的典型原因）时，在新服务器上点登录要白等满 8 秒超时
 */
export async function settleRevoke(): Promise<void> {
  if (revoking && revoking.base === serverStore.current()) await revoking.done
}

/**
 * 本地结束当前服务器上的会话：先落「待撤销」标记（#319）、清 access token、后台撤销。
 * 标记要在请求**之前**落：请求半路 App 被杀也算没确认
 */
export async function forgetServerCredentials(): Promise<void> {
  await logoutPending.add(serverStore.current())
  await tokenStore.clear()
  startRevoke()
}

/**
 * 换服务器（#406）。已登录 / 未登录都走这一条：未登录时 cookie jar 里也可能还留着旧服务器的
 * refresh cookie（冷启动没连上 → 根本没机会恢复或撤销），一样要记标记、补发撤销，
 * 否则以后切回旧地址冷启动会被静默登回去。
 *
 * 🔴 **先在旧服务器上登出、再换地址**：登出请求要打到旧服务器上，打到新服务器上的那次登出
 * 带不上旧服务器的 refresh cookie。`startRevoke` 是同步发出的，紧接着换地址不影响它。
 *
 * `next` 是规范化过的地址（`serverBaseUrl`）；传 null = 回到打包时的默认地址
 */
export async function switchServer(next: string | null): Promise<void> {
  await forgetServerCredentials()
  await serverStore.set(next)
}
