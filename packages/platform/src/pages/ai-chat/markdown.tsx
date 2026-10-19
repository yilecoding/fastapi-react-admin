import * as React from 'react'

/**
 * 一个**零依赖**的极小 Markdown 渲染器，只覆盖对话里真正会出现的那几种语法：
 * 代码块 / 行内代码 / 粗体 / 标题 / 有序无序列表 / GFM 表格 / 引用块 / 段落。
 *
 * 🔴 **它构造的是 React 元素，全程没有 `dangerouslySetInnerHTML`。**
 * 这不是实现细节，是安全属性：AI 的输出里混着用户提问和工具返回的业务数据
 * （部门名、备注……），那些都是不受信任的文本。用 innerHTML 渲染 markdown
 * 就等于给后台开了一个 XSS 入口，而且触发它只需要有人把 `<img onerror=…>`
 * 存进某个部门的备注里。
 *
 * ⚠️ 覆盖面**故意**不全（没有嵌套列表、图片、链接跳转）。
 * 真需要完整 markdown 时再引 `react-markdown` + `rehype-sanitize`——
 * 这一层是可替换的，调用方只认 `<Markdown text={...} />`。
 */

/** 行内语法：`code` 与 **bold**。按出现顺序切片，不做嵌套。 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-c${index}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      nodes.push(<strong key={`${keyPrefix}-b${index}`}>{token.slice(2, -2)}</strong>)
    }
    last = match.index + token.length
    index += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
      {lang ? <div className="mb-1 text-[10px] text-muted-foreground">{lang}</div> : null}
      <code className="font-mono whitespace-pre">{code}</code>
    </pre>
  )
}

function Table({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows
  return (
    // 表格可能很宽，单独给一个横向滚动容器 —— 不给的话它会把整条消息撑宽，
    // 进而把整个内容区顶出横向滚动条（shell 分册那条 `min-w-0` 的同类）
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="border px-2.5 py-1.5 text-left font-medium whitespace-nowrap">
                {renderInline(cell, `th${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border px-2.5 py-1.5">
                  {renderInline(cell, `td${r}-${c}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const splitRow = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // 代码块：``` 开头，吃到下一个 ``` 为止。
    // ⚠️ 没有闭合的 ``` 也要正常收尾 —— 流式输出时代码块**一定**会有一段时间是没闭合的
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push(<CodeBlock key={key++} code={body.join('\n')} lang={lang} />)
      continue
    }

    // GFM 表格：当前行和下一行分别是表头与分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows: string[][] = [splitRow(line)]
      i += 2
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      blocks.push(<Table key={key++} rows={rows} />)
      continue
    }

    // 引用块：连续的 `> ` 行归成一组。
    // 实测模型很爱用它写「注：…」这类补充说明，不支持的话 `>` 会原样露在界面上
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push(
        <blockquote key={key++} className="my-2 border-s-2 ps-3 text-muted-foreground">
          {quoted.map((q, index) => (
            <p key={index} className="my-0.5">
              {renderInline(q, `q${key}-${index}`)}
            </p>
          ))}
        </blockquote>,
      )
      continue
    }

    // 标题
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const size = level === 1 ? 'text-base' : level === 2 ? 'text-sm' : 'text-xs'
      blocks.push(
        <div key={key++} className={`mt-2 mb-1 font-semibold ${size}`}>
          {renderInline(heading[2], `h${key}`)}
        </div>,
      )
      i += 1
      continue
    }

    // 列表：连续的 - / * / 1. 行归成一组
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = []
      const ordered = /^\s*\d+\.\s+/.test(line)
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i += 1
      }
      const ListTag = ordered ? 'ol' : 'ul'
      blocks.push(
        <ListTag key={key++} className={`my-1 ms-5 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((item, index) => (
            <li key={index}>{renderInline(item, `li${key}-${index}`)}</li>
          ))}
        </ListTag>,
      )
      continue
    }

    // 空行跳过；其余当段落
    if (line.trim()) {
      blocks.push(
        <p key={key++} className="my-1 leading-relaxed whitespace-pre-wrap">
          {renderInline(line, `p${key}`)}
        </p>,
      )
    }
    i += 1
  }

  return <>{blocks}</>
}
