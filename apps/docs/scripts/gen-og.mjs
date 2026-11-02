#!/usr/bin/env node
/**
 * 生成链接分享卡片 `public/og.png`（1280×640）：左边品牌和一句话，右边仪表盘截图。
 *
 * 文档站每一页的 og:image 都指向它（astro.config.mjs 的 head）；同一张图也是 GitHub 仓库
 * Settings → Social preview 要传的那张（GitHub 建议 1280×640，只能网页上传）。
 *
 * 换了截图或品牌色之后跑一遍：
 *     pnpm --filter @admin/docs og
 *
 * 文字只用英文：sharp 用系统字体渲染 SVG 里的文字，CI 和别人的机器上未必有中文字体，
 * 缺字的表现是一排方框，而且不报错。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const OUT = resolve(HERE, '../public/og.png')

const W = 1280
const H = 640
// 截图 1600×960 等比缩到 700 宽、靠右；再宽就会压住左边 44px 的项目名
const SHOT_W = 700
const SHOT_H = Math.round(SHOT_W * 960 / 1600)
const SHOT_X = W - SHOT_W - 48
const SHOT_Y = (H - SHOT_H) / 2

const logo = readFileSync(resolve(ROOT, 'apps/web/public/favicon.svg'), 'utf8')
  .replace('<svg ', '<svg width="72" height="72" ')

const background = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4630db"/>
      <stop offset="1" stop-color="#1e1466"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g font-family="Ubuntu Sans, DejaVu Sans, sans-serif" fill="#fff">
    <text x="64" y="232" font-size="44" font-weight="700">fastapi-react-admin</text>
    <text x="64" y="292" font-size="24" fill-opacity="0.85">Admin foundation</text>
    <text x="64" y="326" font-size="24" fill-opacity="0.85">FastAPI + React 19 + shadcn/ui</text>
    <text x="64" y="420" font-size="20" fill-opacity="0.7">Row-level data permissions</text>
    <text x="64" y="452" font-size="20" fill-opacity="0.7">Multi-tab that keeps state</text>
    <text x="64" y="484" font-size="20" fill-opacity="0.7">Approval workflow · AI assistant</text>
    <text x="64" y="516" font-size="20" fill-opacity="0.7">PostgreSQL · SQL Server · MySQL</text>
  </g>
</svg>`)

const radius = 14
const mask = Buffer.from(
  `<svg width="${SHOT_W}" height="${SHOT_H}"><rect width="${SHOT_W}" height="${SHOT_H}" rx="${radius}" fill="#fff"/></svg>`,
)
const shot = await sharp(resolve(ROOT, 'docs/screenshots/dashboard.png'))
  .resize(SHOT_W, SHOT_H)
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer()
const shadow = await sharp(Buffer.from(
  `<svg width="${SHOT_W + 80}" height="${SHOT_H + 80}"><rect x="40" y="48" width="${SHOT_W}" height="${SHOT_H}" rx="${radius}" fill="#000" fill-opacity="0.45"/></svg>`,
)).blur(18).png().toBuffer()

await sharp(background)
  .composite([
    { input: Buffer.from(logo), left: 64, top: 112 },
    { input: shadow, left: SHOT_X - 40, top: SHOT_Y - 40 },
    { input: shot, left: SHOT_X, top: SHOT_Y },
  ])
  .png({ compressionLevel: 9 })
  .toFile(OUT)

console.log(`wrote ${OUT.replace(`${ROOT}/`, '')} (${W}×${H})`)
