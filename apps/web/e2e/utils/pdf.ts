/**
 * 最小可用的单页 PDF（Helvetica 写一行字）。现造，不提交二进制固件（理由同 `xlsx.ts`）。
 *
 * xref 偏移要算对，否则 PDF.js 会走「修复」路径，测不到正常加载。
 * `file-preview.spec.ts`（资产路径）和 `notice-reach.spec.ts`（读者预览 / 下载公告附件）共用。
 */
export function buildPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}
