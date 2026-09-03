import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    /*
     * 🔴 **`data-grid/` 关掉 `no-explicit-any`，其余目录照旧 error。**
     *
     * 这几个文件是 TanStack Table v9 的**泛型包装层**，收的是它的实例对象
     * （`row` / `column` / `table`）。要如实标注就得把 `Table<TData>` /
     * `Column<TData, TValue>` 的 `TData` 一路穿到每个组件的签名上 ——
     * 8 个组件全部变成泛型，而调用方拿到的类型推断并不会因此变好
     * （表格的列定义本来就是 `unknown[]`）。
     *
     * ⚠️ **不要把这条放宽到整个包。** 关在这一个目录里是刻意的：
     * `data-grid/` 之外新写一个 `any` 仍然是**错误**。
     *
     * ⚠️ 也不要改成 `warn` —— 52 条永远不会去修的 warning 等于没有这条规则，
     * 而且会把真正该看的 warning 埋掉。
     */
    files: ['src/components/data-grid/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    /*
     * 🔴 **组件库里关掉 `set-state-in-effect`，而 `apps/mobile` 保持 error。**
     * 这个差别是刻意的，判据是**那个 setState 在同步什么**：
     *
     * | | 命中的形态 | 有没有更好的写法 |
     * |---|---|---|
     * | `apps/mobile` | effect 里**发请求** + 同步置 loading | 有 —— 换成 TanStack Query，3 处全消失（已做） |
     * | 这里 | 把**受控 prop / 外部默认值**镜像进本地 state | 没有 |
     *
     * 组件库的活就是这个：输入框要能自由输入（本地 state），但外部改了值也得
     * 跟上（`column-filter` 的 `setV`、`toolbar` 的 `setLocalSearch`、
     * `use-grid-view` 的 `setView`、`query-bar` 的默认视图）。四处都有 ref 守卫
     * 或稳定依赖，**不会级联请求**，代价只是多一次渲染。
     *
     * 那条规则本身是给 React Compiler 提性能建议的，不是正确性检查
     * （`eslint-plugin-react-hooks@7` 新增的那一批都是）。完整的取舍和判据写在
     * `packages/platform/eslint.config.mjs` 里，那边把整批都关了。
     *
     * ⚠️ 不要因此把它在**整个仓库**关掉 —— `apps/mobile` 保持 error，
     * 因为那边一旦有人在 effect 里取数，这条抓的就是真问题。
     */
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
