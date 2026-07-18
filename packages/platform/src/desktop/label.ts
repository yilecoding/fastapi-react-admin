/**
 * 贴纸/小票的 HTML 模板。
 *
 * 为什么模板在这里而不在主进程：主进程只负责「把这段 HTML 送去打印」，
 * 排版是业务的事。放在 platform 里，业务页面可以直接 import、在浏览器里
 * 先渲染出来看效果，调完再交给 `desktop().print.html()`。
 *
 * ⚠️ 二维码不要靠 CSS 缩放。标签机通常是 203dpi，浏览器按 CSS 像素排版后
 * 光栅化到 203dpi 会重采样，二维码这种高频黑白图案最容易糊到扫不动。
 * 正确做法是**按目标 dpi 生成整数倍像素的 PNG**（见 qrPixelSize），
 * 以 data URI 传进来，再用 `image-rendering: pixelated` 禁止插值。
 */

export interface LabelField {
  label: string
  value: string
  /** 强调显示（更大字号、加粗）。姓名、单号这类用它 */
  emphasis?: boolean
}

export interface LabelTemplateInput {
  /** 纸张宽，毫米 */
  widthMm: number
  /** 纸张高，毫米 */
  heightMm: number
  title?: string
  fields: LabelField[]
  /** 二维码图片的 data URI（`data:image/png;base64,...`）。不传就不画二维码 */
  qrDataUri?: string
  /** 二维码边长，毫米。默认取高度的 45% */
  qrSizeMm?: number
  /** 底部小字，比如打印时间、终端编号 */
  footer?: string
}

/**
 * 算出二维码 PNG 应该生成多少像素，才能在目标 dpi 下不被重采样。
 *
 * 例：60mm 标签上放 18mm 二维码、打印机 203dpi →
 *   18mm = 0.7087in × 203dpi ≈ 144px。生成 144×144 的 PNG，
 *   CSS 里写 `width: 18mm`，光栅化时正好 1:1。
 */
export function qrPixelSize(sizeMm: number, dpi = 203): number {
  return Math.round((sizeMm / 25.4) * dpi)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  )
}

export function buildLabelHtml(input: LabelTemplateInput): string {
  const { widthMm, heightMm, title, fields, qrDataUri, footer } = input
  const qrSizeMm = input.qrSizeMm ?? Math.round(heightMm * 0.45)

  const rows = fields
    .map(
      (f) => `
      <div class="row${f.emphasis ? " emphasis" : ""}">
        <span class="k">${escapeHtml(f.label)}</span>
        <span class="v">${escapeHtml(f.value)}</span>
      </div>`
    )
    .join("")

  // @page 的 size 与 PrintOptions.pageSize 必须一致，否则 Chromium 会缩放页面去适配，
  // 表现是内容整体偏小、边上留一圈白 —— 看起来像「打印机纸张设错了」，其实是这里对不上。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${widthMm}mm;
    height: ${heightMm}mm;
    /* 不要用带连字/变量轴的字体：标签机驱动光栅化时对可变字体的处理各家不一。
       系统黑体最稳，而且终端机上一定装了 */
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    /* 打印时禁止 Chromium 自作主张调整字号 */
    -webkit-text-size-adjust: none;
    display: flex;
    flex-direction: column;
    padding: 2mm 2.5mm;
  }
  .title { font-size: 3.2mm; font-weight: 700; letter-spacing: .2mm; margin-bottom: 1.2mm; }
  .main { display: flex; gap: 2mm; flex: 1; min-height: 0; }
  .fields { flex: 1; min-width: 0; }
  .row { display: flex; gap: 1.2mm; align-items: baseline; line-height: 1.35; }
  .row .k { font-size: 2.6mm; color: #000; opacity: .65; white-space: nowrap; }
  .row .v { font-size: 2.9mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.emphasis .v { font-size: 4.2mm; font-weight: 700; }
  .qr { width: ${qrSizeMm}mm; height: ${qrSizeMm}mm; flex: 0 0 auto; }
  /* 关键：禁止插值。少了这行，二维码在 203dpi 上会被平滑成灰边，扫码率明显下降 */
  .qr img { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
  .footer { font-size: 2.2mm; opacity: .6; margin-top: 1mm; }
</style>
</head>
<body>
  ${title ? `<div class="title">${escapeHtml(title)}</div>` : ""}
  <div class="main">
    <div class="fields">${rows}</div>
    ${qrDataUri ? `<div class="qr"><img src="${qrDataUri}" alt="" /></div>` : ""}
  </div>
  ${footer ? `<div class="footer">${escapeHtml(footer)}</div>` : ""}
</body>
</html>`
}
