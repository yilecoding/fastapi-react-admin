import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * `packages/platform` 的 eslint。
 *
 * 🔴 **这个包的 `package.json` 一直声明着 `"lint": "eslint"`，但既没装 eslint
 * 也没有配置** —— 于是 `pnpm lint`（`turbo lint`，写在根 CLAUDE.md 里的脚本）
 * 一路 `eslint: not found` 失败。没人碰到，是因为 CI 的 eslint job 跑的是
 * `pnpm --filter web lint`，绕过了它。**现在 CI 改跑 `pnpm lint`。**
 */

/**
 * 🔴 **`eslint-plugin-react-hooks@7` 新增的那批规则本仓库一律关掉。**
 *
 * 它们不是「经典的」hooks 规则（`rules-of-hooks` / `exhaustive-deps` 那两条
 * **保持 error**），而是 **React Compiler** 的诊断：报的是「Compiler 优化不了
 * 这一段」，不是「这一段是错的」。**本仓库不用 React Compiler。**
 *
 * 第一次打开它们时 `packages/platform` 有 83 条、`packages/ui` 有 58 条。
 * 逐条看过之后，**没有一条是功能 bug**，命中的全是两种正当形态：
 *
 * | 形态 | 例子 |
 * |---|---|
 * | 受控 prop 镜像进本地 state | `_shared/filters.tsx` 的 `setLocal(value)` |
 * | 弹窗/抽屉打开时重置表单 | `user/security-sheet.tsx`、`role/user-picker.tsx` |
 *
 * ⚠️ 特别确认过：**没有一处是「在 effect 里取数」** —— platform 的数据全走
 * TanStack Query。那才是 `set-state-in-effect` 真正值钱的时候
 * （`apps/mobile` 就是被它指出来的：三个 bug 同一个根因，引入 query 层后归零）。
 *
 * ⚠️ **不要改成 `warn`** —— 一百多条永远不会去修的 warning 等于没有这些规则，
 * 还会把真正该看的 warning 埋掉。哪天真上了 React Compiler，再把这一段删掉，
 * 那时它们才是可执行的。
 */
export const reactCompilerRulesOff = {
  'react-hooks/set-state-in-effect': 'off',
  'react-hooks/purity': 'off',
  'react-hooks/refs': 'off',
  'react-hooks/immutability': 'off',
  'react-hooks/preserve-manual-memoization': 'off',
  'react-hooks/static-components': 'off',
  'react-hooks/incompatible-library': 'off',
  'react-hooks/use-memo': 'off',
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactCompilerRulesOff,
      // 「解构出来只为了不透传」是常规写法（`preferences.ts` 靠它丢弃旧的
      // `fontSize` 字段）。有 `...rest` 兄弟时应当忽略。
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    /*
     * TanStack Table v9 的泛型包装层：收的是它的实例对象（`row` / `column` /
     * `table`）。要如实标注就得把 `Table<TData>` 的 `TData` 一路穿到每个签名上，
     * 而调用方拿到的推断并不会因此变好（列定义本来就是 `unknown[]`）。
     * ⚠️ 关在这几个目录里是刻意的，别处新写 `any` 仍然是错误。
     */
    files: [
      'src/pages/_shared/**/*.{ts,tsx}',
      'src/pages/**/columns.tsx',
      'src/pages/**/features.ts',
      'src/shell/tab-outlet.tsx',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    /*
     * playground / dev-sandbox 是**开发期的演示页**（30 个 `any` 里的 30 个都在
     * 这儿），存在的意义就是把组件的各种形态摆出来试。⚠️ 别把这条放宽到别处。
     */
    files: ['src/pages/playground-table/**/*.{ts,tsx}', 'src/pages/dev-sandbox/demos/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
])
