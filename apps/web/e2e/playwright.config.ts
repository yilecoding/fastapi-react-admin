import path from "node:path"
import { defineConfig, devices } from "@playwright/test"

/**
 * E2E 打的是一套完全隔离的实例，和你手动 `pnpm dev` 起的 1125/8000 不共用端口、
 * 不共用数据库 —— 具体隔离了什么、为什么隔离，见 CLAUDE.md「E2E 测试」一节。
 *
 *   web  :1126  →  api :8001  →  fba_test（不是开发用的 fba）
 */
const WEB_PORT = 1126
const API_PORT = 8001
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // 本地调试时并行会让失败截图/trace 交错着打印，调试单条用例时更想要顺序执行。
  // CI 里要速度，交给 Playwright 按 CPU 数自己定。
  workers: process.env.CI ? undefined : 1,
  // 终端一直要有（跑起来时能看进度、失败立刻看到错误堆栈），HTML 报告**本地也留一份**——
  // 不是 CI 独有：`pnpm exec playwright show-report` 能直接在浏览器里点开每条用例的
  // 截图/trace，比在终端里翻堆栈方便得多。`open: "never"` 只是不自动弹浏览器，
  // 报告文件（`apps/web/playwright-report/`）照样生成。
  reporter: [["list"], ["html", { open: "never" }]],

  // 一次性环境准备：把 fba_test 里的登录验证码关掉。不放进每条测试的 fixture——
  // 它是环境准备，不是测试本身的一部分。见 global-setup.ts 头注释。
  globalSetup: "./global-setup.ts",

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // 起两个完全独立于你手动 `pnpm dev` 的进程。`reuseExistingServer` 在非 CI 时打开——
  // 反复跑测试时不用每次等它们冷启动，但代价是如果这两个端口被别的东西占了，
  // Playwright 会误以为是自己起的服务，看见的行为会很怪，先排除端口冲突再排查测试本身。
  webServer: [
    {
      // 🔴 脚本名不能叫 `e2e` —— `apps/api/package.json` 里那个脚本刻意叫
      // `e2e:server`。`turbo e2e`（= `pnpm e2e`）按脚本名把两个包的 `e2e`
      // 任务都跑起来，如果 api 那边也叫 `e2e`，turbo 会独立起一份，
      // Playwright 这里的 webServer 又会再起一份 —— 两个进程抢同一个 8001 端口
      // （实测踩过：`address already in use`，凑巧没影响到测试结果，但是巧合不是保证）。
      command: "pnpm --filter api e2e:server",
      cwd: REPO_ROOT,
      url: `http://127.0.0.1:${API_PORT}/openapi`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter web dev",
      cwd: REPO_ROOT,
      env: {
        // vite.config.ts 只在这个变量存在时才偏离固定的 1125（见那边的注释）
        E2E_WEB_PORT: String(WEB_PORT),
        // api-client 的 API_BASE 和 /uploads 代理目标都读这个变量，早就是可覆盖的
        VITE_API_BASE: `http://127.0.0.1:${API_PORT}`,
      },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
})
