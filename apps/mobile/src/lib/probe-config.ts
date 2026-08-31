/**
 * 探针要打的后端地址。
 *
 * 默认 `http://10.0.2.2:8088` —— **Android 模拟器里的 `10.0.2.2` 就是宿主的
 * `127.0.0.1`**（这里的「宿主」是 WSL 本身）。刻意用它而不是局域网地址：
 * 全程留在 WSL 内部，不往局域网开任何口（见 AGENTS.md 那张被否掉的解法表）。
 *
 * ⚠️ 这是**明文 HTTP**，只在 dev 下成立。生产必须是域名 + HTTPS
 * （Let's Encrypt 的证书签给 `fra.wubunan.com`，走 IP 会 TLS 失败，
 * 而 RN 报的是一个笼统的 `Network request failed`，不提「证书」两个字）。
 */
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'http://10.0.2.2:8088'
