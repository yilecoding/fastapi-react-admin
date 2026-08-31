/**
 * 壳指向哪个站点。
 *
 * ⚠️ **必须用域名，不能用 IP。** 生产的证书是 Let's Encrypt 签给
 * `fra.wubunan.com` 的，走 IP 访问会因为 CN 不匹配直接 TLS 失败 ——
 * 而 WebView 报出来的是一个笼统的加载错误，不会说「证书」两个字。
 *
 * ⚠️ **必须是 HTTPS。** iOS 的 ATS 和 Android 的 cleartext 策略默认都拦明文 HTTP。
 * 本地对着 dev server 调试时需要在 `app.json` 里开例外，而那条例外**极容易被
 * 顺手带进 release 配置** —— 一带就是全站明文传 token。所以这里不提供
 * 「自动降级到 http」的便利，要连 dev server 就显式改这个环境变量并自己开例外。
 */
const DEFAULT_URL = 'https://fra.wubunan.com'

export const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? DEFAULT_URL

/** 是不是默认值 —— 界面上标一下，免得对着错的站点排查半天 */
export const IS_DEFAULT_URL = WEB_URL === DEFAULT_URL
