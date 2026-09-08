/**
 * 造一份最小可用的 xlsx，给导入类用例当输入。
 *
 * 🔴 **为什么不提交一个 .xlsx 固件**：表格里的 `dept_code` / `role_codes` 必须是
 * **这套库里真实存在**的编码，而 `fba_test` 的种子会变（实测它现在还混着历次
 * E2E 留下的 `PROBE20` / `E2EDPR_*`）。固件写死编码的话，种子一改用例就红，
 * 而真正的坏处是它**也可能不红** —— 编码恰好还在，但已经不是当初那条数据了。
 * 所以编码从接口现读、表格现造。
 *
 * ⚠️ **zip 自己手写，不引 jszip。** 试过了：jszip 是 CJS，在 Playwright 的 TS
 * 加载器下当场 `Unexpected module status 3`（CJS/ESM 互操作），而这里需要的
 * 只是「把 5 个 XML 文件打成一个包」——用 **STORE**（不压缩）就够，
 * xlsx 读取器一律接受，省掉一个依赖和一类互操作风险。
 *
 * 只实现导入用例需要的那点子集：单工作表、字符串按**内联字符串**写
 * （`t="inlineStr"`），不生成 sharedStrings.xml。数字单元格保留原样 ——
 * 「Excel 里直接打的手机号是数字」正是解析层要归一的那个形状，
 * 用例得造得出来。
 */

export type Cell = string | number | null

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function colName(i: number): string {
  let n = i + 1
  let out = ""
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function cellXml(value: Cell, ref: string): string {
  if (value === null || value === "") return ""
  if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`
}

// ── 一个只会 STORE 的 zip 打包器 ──────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

type Entry = { name: string; data: Buffer }

function zipStore(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 需要的版本
    local.writeUInt16LE(0x0800, 6) // 通用标志：文件名是 UTF-8
    local.writeUInt16LE(0, 8) // 压缩方法 0 = STORE
    local.writeUInt16LE(0, 10) // 修改时间（用例不关心，固定值让产物可复现）
    local.writeUInt16LE(0x21, 12) // 修改日期（1980-01-01）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + size
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, end])
}

/**
 * @param rows 第一行是表头
 * @returns xlsx 字节，直接喂给 Playwright 的 `setInputFiles({ buffer })`
 */
export function buildXlsx(rows: Cell[][], sheetTitle = "data"): Buffer {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row.map((v, c) => cellXml(v, `${colName(c)}${r + 1}`)).join("")
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join("")

  const xml = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`, "utf8")

  return zipStore([
    {
      name: "[Content_Types].xml",
      data: xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `</Types>`
      ),
    },
    {
      name: "_rels/.rels",
      data: xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`
      ),
    },
    {
      name: "xl/workbook.xml",
      data: xml(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets><sheet name="${esc(sheetTitle)}" sheetId="1" r:id="rId1"/></sheets>` +
          `</workbook>`
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: xml(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<sheetData>${sheetRows}</sheetData>` +
          `</worksheet>`
      ),
    },
  ])
}
