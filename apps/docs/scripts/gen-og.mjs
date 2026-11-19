#!/usr/bin/env node
/**
 * 生成链接分享卡片 `public/og.png`（1280×640）：左边大标题，右边登录页同款的 3D 榫卯，右下角仓库名。
 *
 * 文档站每一页的 og:image 都指向它（astro.config.mjs 的 head）；同一张图也是 GitHub 仓库
 * Settings → Social preview 要传的那张（GitHub 建议 1280×640，只能网页上传，< 1MB）。
 *
 * 换了登录页截图、品牌色或文案之后跑一遍：
 *     pnpm --filter @admin/docs og
 *
 * 为什么用浏览器渲染、不再用 sharp 拼 SVG：这张图在 GitHub 手机端的「探索」流里只有约 400px 宽，
 * 原来那版（小字 + 缩小的仪表盘截图）缩下去只剩一块紫色，字和截图都看不清（2026-11-19 用户截图反馈）。
 * 现在只放大字和品牌视觉，需要真正的排版（字重、字距、渐变字、蒙版），SVG 文字做不到。
 *
 * - 字体用文档站已有的 @fontsource-variable/inter 与 jetbrains-mono，以 data URI 内联：
 *   不走 Google Fonts（国内会卡住），也不依赖系统字体（CI 和别人的机器上未必有，缺字不报错）
 * - 文字只用英文：分享卡片面向 GitHub 和海外社交平台，而且 Inter 没有中文字形
 * - 榫卯取自 `docs/screenshots/sign-in.png`（3200×1920 的 2 倍图）左栏，按下面 TENON 的偏移裁出来。
 *   重拍登录页后榫卯位置变了，就调 TENON，再看一眼输出
 * - Playwright 借 apps/web 的依赖（文档站自己不装浏览器）
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const OUT = resolve(HERE, '../public/og.png')

const docsRequire = createRequire(resolve(HERE, '../package.json'))
const { chromium } = createRequire(resolve(ROOT, 'apps/web/package.json'))('@playwright/test')

const W = 1280
const H = 640
const REPO = 'yile2020/fastapi-react-admin'
/** 登录页截图按 1600 宽（半尺寸）铺，再平移这么多，榫卯正好落在 620×560 的窗口中间 */
const TENON = { size: 1600, x: -120, y: -110 }

const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`
const font = (pkg, file) => dataUri(docsRequire.resolve(`${pkg}/files/${file}`), 'font/woff2')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;font-weight:100 900;src:url(${font('@fontsource-variable/inter', 'inter-latin-wght-normal.woff2')}) format('woff2')}
@font-face{font-family:Mono;font-weight:100 800;src:url(${font('@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2')}
*{margin:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;overflow:hidden;position:relative;background:#f1f0fc;color:#16123a;
  font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased}
.art{position:absolute;right:-100px;top:30px;width:620px;height:560px;
  background:url(${dataUri(resolve(ROOT, 'docs/screenshots/sign-in.png'), 'image/png')}) ${TENON.x}px ${TENON.y}px/${TENON.size}px auto no-repeat;
  transform:scale(1.18);transform-origin:right center;-webkit-mask-image:radial-gradient(closest-side,#000 62%,transparent 100%)}
.t{position:absolute;left:72px;top:80px;width:700px}
.brand{display:flex;align-items:center;gap:14px;font-size:26px;font-weight:600;letter-spacing:-.01em}
.brand svg{width:44px;height:44px}
h1{margin-top:56px;font-size:70px;line-height:1.04;font-weight:800;letter-spacing:-.045em}
h1 em{font-style:normal;background:linear-gradient(90deg,#4630db,#c03fb0);-webkit-background-clip:text;color:transparent}
.sub{margin-top:28px;font-size:25px;color:#4b4772;line-height:1.4}
.foot{position:absolute;left:72px;right:72px;bottom:52px;display:flex;justify-content:space-between;align-items:center;
  font-family:Mono,monospace;font-weight:500;font-size:18px;letter-spacing:.04em}
.stack{color:#4630db}
.by{display:flex;gap:10px;align-items:center;padding:9px 18px;border-radius:999px;
  background:rgba(255,255,255,.75);border:1px solid rgba(70,48,219,.18)}
.by svg{width:20px;height:20px}
</style></head><body>
<div class="art"></div>
<div class="t">
  <div class="brand">${readFileSync(resolve(ROOT, 'apps/web/public/favicon.svg'), 'utf8')}fastapi-react-admin</div>
  <h1>Admin foundation that fits <em>like joinery.</em></h1>
  <div class="sub">Row-level permissions · tabs that keep state<br>approval workflow · permission-bound AI</div>
</div>
<div class="foot">
  <span class="stack">FASTAPI + REACT 19 · POSTGRESQL / SQL SERVER / MYSQL</span>
  <span class="by"><svg viewBox="0 0 16 16"><path fill="#16123a" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>${REPO}</span>
</div>
</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  // 字体没加载上会静默回退到系统字体，图照样出 —— 这里卡住
  const ok = await page.evaluate(() => document.fonts.check('800 70px Inter') && document.fonts.check('500 18px Mono'))
  if (!ok) throw new Error('Inter / JetBrains Mono 没加载上，检查 @fontsource-variable 的文件名')
  await page.screenshot({ path: OUT })
} finally {
  await browser.close()
}
console.log(`wrote ${OUT.replace(`${ROOT}/`, '')} (${W}×${H})`)
