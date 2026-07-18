// platform 被 Vite 应用消费，会读 import.meta.env，但本包不依赖 vite，
// 拿不到 vite/client 的全局类型 —— 这里只声明本包实际用到的两个变量。
// 新增 VITE_ 变量时必须同步加到这里，否则本包 typecheck 会报 TS2339。
interface ImportMetaEnv {
  readonly DEV: boolean
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env?: ImportMetaEnv
}
