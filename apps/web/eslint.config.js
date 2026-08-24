import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // public/file-viewer/vendor 是 file-viewer 的 vite 插件在 dev/build 时拷进来的
  // 第三方产物（不进 git，见根 .gitignore），本机跑过一次 `pnpm dev` 之后就会在
  // 磁盘上出现 —— 不忽略的话本地 `pnpm lint` 会去 lint 一份没做过转译的 pdfjs
  // worker，报一堆 `es/no-*` 兼容性规则错误。CI 是全新 checkout、这个目录本来就
  // 不存在，所以这条只影响本地体验，不影响 CI 结果。
  globalIgnores(['dist', 'public/file-viewer/vendor']),
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
    files: ['src/routes/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Playwright fixture 文件，不是 React 代码：`(fixtures, use) => {}` 是 Playwright
    // 自己的 API 形状，第一个参数常年是空对象占位（不依赖别的 fixture），第二个参数
    // 叫 `use` 只是撞上了 react-hooks 按名字识别 Hook 的启发式规则，两条规则在这里
    // 都是误报。
    files: ['e2e/**/*.{ts,tsx}'],
    rules: {
      'no-empty-pattern': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
])
