#!/usr/bin/env node
/**
 * 品牌图标生成器 —— 唯一真相源。
 *
 * 图形本身就是 `apps/web/src/components/tenon-mark.tsx` 那两片路径（榫 + 卯），
 * 套进一个纯色圆形徽章里，给「没有周围主题面板可以贴色」的场合用：浏览器标签页、
 * 桌面端窗口图标/任务栏/安装包图标。TenonMark 组件本身继续用 currentColor 裸跑在
 * 侧边栏和登录页——那两处已经有背景色，不需要徽章。
 *
 * 改了榫卯的路径或配色，改这一份的常量，跑：
 *     pnpm brand:icons
 * 输出：
 *   apps/web/public/favicon.svg          矢量，现代浏览器标签页图标
 *   apps/web/public/favicon-32.png       位图兜底（旧 Safari / 抓取器只认 png）
 *   apps/web/public/apple-touch-icon.png iOS「添加到主屏幕」
 *   apps/desktop/build/icon.png          electron-builder 的图标源
 *     （1024×1024，够它自动派生 .ico / .icns，不用手工转)
 *
 * 不依赖任何图形库：PNG 编码用 node:zlib 手搓 —— 这几个尺寸够小，没必要为此
 * 装一个原生编译的 sharp。
 */
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** 圆形徽章底色。测色自这次定稿的 logo 截图（#4630DB），
 *  与登录页 `--tenon-accent`（oklch(0.457 0.24 277)）同一个色相区间，不是巧合。 */
const PURPLE = [0x46, 0x30, 0xdb]
/** 卯（mortise）那片的透明度 —— 与 tenon-mark.tsx 里的 `fillOpacity="0.45"` 保持一致 */
const MORTISE_OPACITY = 0.45
/** 榫卯合起来的墨迹（ink）以 24×24 视口为单位，中心恰好落在 (12,12) —— 见 tenon-mark.tsx。
 *  1.6 是「墨迹宽度 ≈ 徽章直径的 67%」换算出来的缩放系数，见本文件下方 renderIcon 的推导。 */
const GLYPH_SCALE_AT_D48 = 1.6

// ---- 榫 / 卯的矩形分解（tenon-mark.tsx 的路径都是直角多边形，拆成矩形并/差最简单）----
const inRect = (x, y, x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1
const inTenon = (x, y) => inRect(x, y, 2, 10, 4, 20) || inRect(x, y, 10, 13, 9, 15)
const inMortise = (x, y) =>
  inRect(x, y, 15, 22, 4, 20) && !inRect(x, y, 15, 18, 9, 15)

const MORTISE_RGB = PURPLE.map((c) => Math.round(255 * MORTISE_OPACITY + c * (1 - MORTISE_OPACITY)))

// ---------------------------------------------------------------------------
// 矢量版：直接手写 SVG，坐标就是 renderIcon 用的同一套换算，写在这里方便对照。
// ---------------------------------------------------------------------------
function buildFaviconSvg() {
  const [r, g, b] = PURPLE
  const purpleHex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="24" fill="${purpleHex}" />
  <g transform="translate(24 24) scale(${GLYPH_SCALE_AT_D48}) translate(-12 -12)">
    <path fill="#fff" d="M2 4 H10 V9 H13 V15 H10 V20 H2 Z" />
    <path fill="#fff" fill-opacity="${MORTISE_OPACITY}" d="M15 4 H22 V20 H15 V15 H18 V9 H15 Z" />
  </g>
</svg>
`
}

// ---------------------------------------------------------------------------
// 位图版：4×4 超采样后取平均色，圆边和榫卯的直角边都靠这个抗锯齿。
// ---------------------------------------------------------------------------
function renderIcon(size) {
  const SS = 4
  const big = size * SS
  const cx = big / 2
  const cy = big / 2
  const R = big / 2
  // 徽章直径 48 时的缩放系数是 1.6；直径变了按比例换算，保证墨迹始终占相同比例
  const scale = GLYPH_SCALE_AT_D48 * (big / 48)

  const rgba = Buffer.alloc(size * size * 4)
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ox * SS + sx + 0.5
          const py = oy * SS + sy + 0.5
          const dx = px - cx
          const dy = py - cy
          if (dx * dx + dy * dy > R * R) continue // 圆外：透明,不累加颜色
          const gx = (px - cx) / scale + 12
          const gy = (py - cy) / scale + 12
          let rgb
          if (inTenon(gx, gy)) rgb = [255, 255, 255]
          else if (inMortise(gx, gy)) rgb = MORTISE_RGB
          else rgb = PURPLE
          r += rgb[0]
          g += rgb[1]
          b += rgb[2]
          a += 255
        }
      }
      const n = SS * SS
      const i = (oy * size + ox) * 4
      // 颜色按「落在圆内的子采样数」求平均,而不是除以 n —— 否则圆边会泛白/泛黑一圈
      const covered = a / 255
      rgba[i] = covered > 0 ? Math.round(r / covered) : 0
      rgba[i + 1] = covered > 0 ? Math.round(g / covered) : 0
      rgba[i + 2] = covered > 0 ? Math.round(b / covered) : 0
      rgba[i + 3] = Math.round(a / n)
    }
  }
  return rgba
}

// ---------------------------------------------------------------------------
// 最小 PNG 编码器：8-bit RGBA,不分行 filter(=0),IDAT 走 zlib 默认压缩
// ---------------------------------------------------------------------------
let crcTable
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function writePng(path, size) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, encodePng(size, renderIcon(size)))
  console.log(`  ${path.replace(ROOT + "/", "")}  (${size}×${size})`)
}

console.log("生成品牌图标…")
const svgPath = resolve(ROOT, "apps/web/public/favicon.svg")
mkdirSync(dirname(svgPath), { recursive: true })
writeFileSync(svgPath, buildFaviconSvg())
console.log(`  ${svgPath.replace(ROOT + "/", "")}`)

writePng(resolve(ROOT, "apps/web/public/favicon-32.png"), 32)
writePng(resolve(ROOT, "apps/web/public/apple-touch-icon.png"), 180)
writePng(resolve(ROOT, "apps/desktop/build/icon.png"), 1024)
console.log("done.")
