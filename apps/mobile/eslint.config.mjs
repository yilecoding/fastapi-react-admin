import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/*
 * ⚠️ 文件名必须是 。 **不能加 **
 * （ /  都是 CommonJS，加了当场坏），
 * 而 eslint 读一个  配置时会先按 CJS 解析、失败再重解析成 ESM，
 * 并打一条 MODULE_TYPELESS_PACKAGE_JSON 警告。
 */

/*
 * ⚠️ **文件名必须是 `.mjs`。** `apps/mobile/package.json` 不能加 `type: "module"`
 * （`metro.config.js` / `babel.config.js` 都是 CommonJS，加了当场坏），
 * 而 eslint 读 `.js` 配置时会先按 CJS 解析、失败再重解析成 ESM，
 * 并打一条 MODULE_TYPELESS_PACKAGE_JSON 警告。
 */

/**
 * 移动端的 eslint —— **照 `apps/web/eslint.config.js` 抄，刻意不用 `eslint-config-expo`**。
 *
 * 🔴 Expo 那份配置会经 `eslint-import-resolver-typescript` 拖进带 postinstall 的
 * `unrs-resolver`，而 pnpm 11 对未放行的 build script 是 **exit 1 不是警告** ——
 * 装它要同时改 `pnpm-workspace.yaml` 的 `allowBuilds`。为了一套 lint 规则去放行
 * 一个原生编译的 postinstall 不划算，而且我们真正想要的只有 `react-hooks`。
 *
 * ⚠️ 唯一和 web 那份不同的两处：
 *   - globals 用 `react-native`（有 `__DEV__` / `fetch` / `requestAnimationFrame`，
 *     没有 `document` / `window` 那一批 —— 这正好能当护栏：往 RN 代码里写
 *     `document.xxx` 会被 `no-undef` 抓住，那是 `packages/i18n` 踩过的坑）
 *   - 不接 `eslint-plugin-react-refresh` —— 它的预设是 vite 专用的
 */
export default defineConfig([
  // dist 是 `pnpm build`（expo export）的产物，android/ios 是 prebuild 的原生工程
  globalIgnores(['dist', 'android', 'ios', '.expo', 'uniwind-types.d.ts', 'expo-env.d.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      // ⚠️ `react-native` 这个预设**在 globals v17 才有**（v16 里没有，59 个 RN
      // 全局量全没了，`languageOptions.globals` 收到 undefined 直接
      // `Expected an object` 报错）。所以版本要和 `apps/web` 对齐到 ^17。
      globals: globals['react-native'],
    },
    rules: {
      /*
       * 「解构出来只为了不透传」是 RN 组件里的常规写法 ——
       * `input.tsx` 就靠它把 `placeholderClassName` 拦下来（透传给原生
       * `TextInput` 会报未知 prop）。有 `...rest` 兄弟时应当忽略。
       */
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],

      /*
       * ⚠️ **移动端刻意降级这一条**（`apps/web` 那份是默认的 error，而且过）。
       *
       * 区别在于取数方式：web 走 TanStack Query，压根没有「在 effect 里取数」
       * 这种代码；移动端**没有 query 层**，`login.tsx` 的验证码、
       * `notifications.tsx` 的列表、`lib/notifications.tsx` 的未读数
       * 都是 effect 里发请求 + 同步先置一个 loading 态。
       *
       * 那条规则说的是「同步 setState 会引发级联渲染」—— 是**性能**建议，
       * 不是正确性问题（多一次渲染）。真要消掉得先引入 query 层，
       * 那是独立一件事。降成 warn 而不是 off：将来加了 query 层要能看见它们。
       */
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // expo-router 的**约定式导出**：`_layout.tsx` 要导出 `ErrorBoundary` /
    // `unstable_settings`，`+not-found.tsx` 是默认导出的屏。这些不是组件也不是 hook。
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // scripts/ 是跑在 Node 里的构建脚本，不是 App 代码
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: { globals: globals.node },
  },
])
