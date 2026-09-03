/**
 * `import '@/styles/global.css'` 是 uniwind 的入口副作用导入 —— Metro 侧由
 * `withUniwindConfig` 处理，但 TS 不认识 `.css` 模块，会报 TS2882。
 * uniwind 自己的 `uniwind/types` 没有声明它（1.11.0 实测），所以这里补一条。
 */
declare module '*.css' {}
