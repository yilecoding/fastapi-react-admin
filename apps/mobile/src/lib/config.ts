/**
 * 后端地址。
 *
 * dev 下走 `adb reverse`（见下），生产走域名 —— `EXPO_PUBLIC_API_BASE` 覆盖。
 *
 * 🔴 **走 `adb reverse`，不要用 `10.0.2.2`。**
 * `10.0.2.2` 是「Android 模拟器里的宿主 loopback 别名」那条经典说法，
 * 但**在这台机器上实测是 `connect: Network is unreachable`** —— 这个 emulator
 * 的网络后端没有提供那个别名（`ip route` 也是空的）。而且它只对模拟器成立，
 * 真机没有等价物。
 *
 * `adb reverse tcp:8088 tcp:8088` 把设备的 `127.0.0.1:8088` 隧道到本机的
 * `127.0.0.1:8088`，模拟器和真机（USB）都一样用，而且**不往局域网开任何口** ——
 * 后端可以继续只绑 `127.0.0.1`（`pnpm --filter api dev` 就是这么绑的）。
 *
 * ⚠️ 这是**明文 HTTP**，只在 dev 下成立。生产必须是域名 + HTTPS
 * （Let's Encrypt 的证书签给 `fra.wubunan.com`，走 IP 会 TLS 失败，
 * 而 RN 报的是一个笼统的 `Network request failed`，不提「证书」两个字）。
 */
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'http://127.0.0.1:8088'
