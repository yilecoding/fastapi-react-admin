// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withUniwindConfig } = require('uniwind/metro')
const path = require('node:path')

/**
 * pnpm monorepo 里的 Metro 配置 —— **只需要这一行**。
 *
 * 🔴 **不要抄 Expo monorepo 指南里那份配方。** 它给的
 * `disableHierarchicalLookup: true` + `nodeModulesPaths` 是针对 Yarn / npm 的
 * **提升式布局**；在 pnpm 上开了它，`metro-resolver` 里「从 originModulePath
 * 逐级向上找 node_modules」那整段被跳过，只遍历 nodeModulesPaths ——
 * 而本仓库根 `node_modules` 只有 4 个真实包（prettier / prettier-plugin-tailwindcss /
 * turbo / typescript），`i18next` 只存在于 `packages/i18n/node_modules/`。
 * Metro 解析 workspace 包返回的是 realPath，正要靠向上查找才摸得到它自己的私有依赖目录。
 *
 * **实测过，而且比推理出来的更狠**：开了它，`expo export` 在**第 1 个模块**就失败 ——
 * 炸的不是某个 workspace 包，是 `expo` 自己：
 *
 *     Unable to resolve module expo-modules-core from
 *     node_modules/.pnpm/expo@57.0.18_.../node_modules/expo/src/Expo.ts
 *
 * 好消息是这个失败很响、不会静默；坏消息是**报错里没有一个字提到这份配置** ——
 * 看着像「依赖装坏了」，很容易去反复 `pnpm install` 或删 node_modules 重装。
 * 对照实验：只留 `watchFolders` 时同一个工程 594 模块打包成功（含
 * `@admin/i18n` 及它私有的 `i18next`）。
 *
 * 另外两个曾经写进方案又删掉的：
 *   - `unstable_enableSymlinks` 在 metro-config@0.82+ 已不存在，且 resolver 内
 *     未知 key **不校验** —— 写了是静默丢弃的死配置
 *   - `unstable_enablePackageExports` 从 0.82 起默认就是 true
 */
const config = getDefaultConfig(__dirname)
config.watchFolders = [path.resolve(__dirname, '../..')]

// uniwind 把 global.css 交给 Tailwind v4 自己的引擎编译，产物再转成 RN 样式。
// dtsFile 生成的 `uniwind-types.d.ts` 是**生成产物**，不要手改。
module.exports = withUniwindConfig(config, {
  cssEntryFile: './src/styles/global.css',
  dtsFile: './uniwind-types.d.ts',
})
