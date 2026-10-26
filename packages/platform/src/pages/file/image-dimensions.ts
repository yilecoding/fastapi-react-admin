/**
 * 从图片文件头读宽高，**不解码**。
 *
 * 为什么要它：图片的字节数和解码后的内存不成比例。一张 20000×20000 的纯色 PNG
 * 只有 76KB（后端 5MB 的图片上限挡不住），解码出来是 1.6GB 的 RGBA。
 * 实测（Playwright · 生产构建）预览时主线程最长卡顿：
 *
 * | 尺寸 | 卡顿 |
 * |---|---|
 * | 8000×6000（48MP，手机原图量级） | 191ms |
 * | 12000×12000（144MP） | 548ms |
 * | 20000×20000（400MP） | **5232ms** |
 * | 30000×30000 | 浏览器直接解不了，renderer 自己报「预览失败」 |
 *
 * 所以上限画在 150MP：刚好放过实测还能接受的 144MP，手机原图远在线下。
 * （Orca 那条 32MP 的线照抄会把 48MP 的手机原图也挡掉。）
 *
 * 宫格缩略图**不需要**这道闸：同一批样本在缩略图里主线程最长 40ms ——
 * `<img>` 按显示尺寸解码，不在主线程上铺满全尺寸。
 *
 * 只认 PNG / JPEG / GIF / WebP / BMP。认不出（svg / avif / ico / 截断的文件）
 * 一律返回 `null`，调用方按「放行」处理：读不出尺寸不是拦人的理由。
 */
export type ImageDimensions = { width: number; height: number }

/** 超过这个像素数就不交给预览器（见上表） */
export const IMAGE_PREVIEW_MAX_PIXELS = 150_000_000

export function exceedsPreviewPixels(d: ImageDimensions | null): boolean {
  return d !== null && d.width * d.height > IMAGE_PREVIEW_MAX_PIXELS
}

const ascii = (v: DataView, at: number, len: number) => {
  let s = ''
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(v.getUint8(at + i))
  return s
}

export function readImageDimensions(bytes: ArrayBuffer): ImageDimensions | null {
  const v = new DataView(bytes)
  try {
    return readPng(v) ?? readGif(v) ?? readBmp(v) ?? readWebp(v) ?? readJpeg(v)
  } catch {
    // RangeError：文件比它的头声称的短。截断的文件交给 renderer 去报错
    return null
  }
}

function readPng(v: DataView): ImageDimensions | null {
  // 8 字节签名 + IHDR 块（长度 4 + 类型 4 + 宽 4 + 高 4，大端）
  if (v.byteLength < 24 || v.getUint32(0) !== 0x89504e47 || ascii(v, 12, 4) !== 'IHDR') return null
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

function readGif(v: DataView): ImageDimensions | null {
  if (v.byteLength < 10 || ascii(v, 0, 4) !== 'GIF8') return null
  return { width: v.getUint16(6, true), height: v.getUint16(8, true) }
}

function readBmp(v: DataView): ImageDimensions | null {
  if (v.byteLength < 26 || ascii(v, 0, 2) !== 'BM') return null
  // BITMAPCOREHEADER（头长 12）是 16 位宽高，其余都是 32 位有符号；高为负 = 自上而下存储
  if (v.getUint32(14, true) === 12) return { width: v.getUint16(18, true), height: v.getUint16(20, true) }
  return { width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) }
}

function readWebp(v: DataView): ImageDimensions | null {
  if (v.byteLength < 30 || ascii(v, 0, 4) !== 'RIFF' || ascii(v, 8, 4) !== 'WEBP') return null
  const chunk = ascii(v, 12, 4)
  const u24 = (at: number) => v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16)
  if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 }
  if (chunk === 'VP8L') {
    // 1 字节签名 0x2f 之后：14 位宽-1、14 位高-1，小端位序
    const b0 = v.getUint8(21)
    const b1 = v.getUint8(22)
    const b2 = v.getUint8(23)
    const b3 = v.getUint8(24)
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    }
  }
  if (chunk === 'VP8 ') {
    // 3 字节帧标签 + 起始码 9d 01 2a，然后 14 位宽、14 位高（高 2 位是缩放）
    if (v.getUint8(23) !== 0x9d || v.getUint8(24) !== 0x01 || v.getUint8(25) !== 0x2a) return null
    return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff }
  }
  return null
}

/** SOF 标记（帧头里有宽高）：C0–CF 里除去 C4（DHT）· C8（保留）· CC（DAC） */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function readJpeg(v: DataView): ImageDimensions | null {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null
  let at = 2
  while (at + 4 <= v.byteLength) {
    if (v.getUint8(at) !== 0xff) return null
    const marker = v.getUint8(at + 1)
    // 填充字节：FF FF … 后面才是真正的标记
    if (marker === 0xff) {
      at += 1
      continue
    }
    // 没有长度字段的独立标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }
    if (JPEG_SOF.has(marker)) {
      // FF Cx | 长度 2 | 精度 1 | 高 2 | 宽 2（大端）
      return { width: v.getUint16(at + 7), height: v.getUint16(at + 5) }
    }
    at += 2 + v.getUint16(at + 2)
  }
  return null
}
