/**
 * 富文本正文（公告的 `content`）→ 一串**数据**块，由 `components/rich-text.tsx` 渲染成原生
 * `Text` / `View` / `Image`。这里是纯函数，不碰 RN。
 *
 * ## 为什么自己写，而不是 WebView / HTML 渲染库
 *
 * - **WebView**（`react-native-webview`）：要额外一个原生依赖，正文高度要靠注入脚本量出来
 *   再 `postMessage` 回来，而且深浅色主题得在 HTML 里再抄一份 CSS —— 移动端路线定的就是
 *   「C：RN 原生 UI，不套 web」（`apps/mobile/AGENTS.md` 开头）。更要紧的是 WebView 会**执行**
 *   正文里的东西，那就得先另做一道消毒
 * - **HTML 转 RN 的库**：`package.json` 里一个都没有，为一屏引一个带自己一套样式系统的库不划算
 * - **只显示纯文本**：标题、列表、加粗全丢，公告读起来像一坨
 *
 * 正文是 web 端 Tiptap 编辑器产出的，标签集合是**封闭的**（`packages/ui/src/components/
 * rich-text/index.tsx` 的 `baseExtensions`：StarterKit + TextAlign + Image）：
 * `p` · `h1`–`h6` · `strong` / `em` / `u` / `s` · `code` / `pre` · `blockquote` ·
 * `ul` / `ol` / `li`（`li` 里还套一层 `p`）· `a` · `br` · `hr` · `img`。
 *
 * ## 🔴 安全靠「白名单输出」，不靠「黑名单过滤」
 *
 * 这里**不产出任何能执行的东西**：输出只有文字、样式标记、链接地址、图片地址。
 * 认不出来的标签一律当透明容器（只留里面的文字）；`script` / `style` 这类连内容一起丢；
 * 属性只读 `href` / `src` / `alt` / `style`（只取 `text-align`）/ `start` / `width` / `height`。
 * 链接和图片地址的协议在渲染侧再筛一遍（只放 `http(s)` / `mailto` / `tel`，图片只放本服务器）。
 */

export type Align = 'left' | 'center' | 'right' | 'justify'

/** 一段行内文字及其样式。相邻的同样式片段会合并 */
export type Inline = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  href?: string
}

export type Block =
  | { kind: 'paragraph'; runs: Inline[]; align?: Align }
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Inline[]; align?: Align }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'image'; src: string; alt: string; width?: number; height?: number }

type Element = { tag: string; attrs: Record<string, string>; children: Node[] }
type Node = Element | { text: string }

/** 没有闭合标签的元素 */
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'])
/** 里面是原始文本（可能含 `<`）—— 必须一路跳到对应的闭合标签，**连内容一起丢** */
const RAW_DROP = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])
/** 正常解析，但整棵子树丢掉（不是文字内容，或者是交互控件） */
const SUBTREE_DROP = new Set(['head', 'template', 'svg', 'math', 'object', 'select', 'button', 'video', 'audio', 'canvas', 'picture'])
/** 只读这几个属性，其余一律不进数据 */
const KEPT_ATTRS = new Set(['href', 'src', 'alt', 'style', 'start', 'width', 'height'])

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'dl', 'dt', 'dd', 'address', 'details', 'summary',
])

/** 正文里有没有标签。种子数据和 #186 之前的老公告是**纯文本**（换行就是分段） */
export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i.test(s)
}

export function parseRichText(input: string): Block[] {
  const src = input ?? ''
  if (!src.trim()) return []
  if (!looksLikeHtml(src)) return plainBlocks(src)
  return compact(toBlocks(tokenize(src).children, false))
}

/**
 * 纯文本：空行分段，段内的单个换行保留。
 *
 * ⚠️ 和 web 不一样是刻意的：web 把它塞给 Tiptap 当 HTML 解析，换行被折成空格，
 * 种子那条「系统升级公告」在 web 上是一整段。手机屏窄，挤成一段几乎没法读。
 */
function plainBlocks(src: string): Block[] {
  return src
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim() !== '')
    .map((p) => ({ kind: 'paragraph' as const, runs: [{ text: p }] }))
}

// ---------------------------------------------------------------------------
// 词法 + 建树（容错：多余的闭合标签忽略，没闭合的在父级闭合时一起收）
// ---------------------------------------------------------------------------

function tokenize(src: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] }
  const stack: Element[] = [root]
  const top = () => stack[stack.length - 1] ?? root
  let i = 0

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      pushText(top(), src.slice(i))
      break
    }
    if (lt > i) pushText(top(), src.slice(i, lt))

    // 注释
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end === -1 ? src.length : end + 3
      continue
    }
    // <!DOCTYPE …> / <?xml …?> 之类
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt)
      i = end === -1 ? src.length : end + 1
      continue
    }

    const gt = tagEnd(src, lt)
    const m = gt === -1 ? null : /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*)>$/.exec(src.slice(lt, gt + 1))
    if (!m) {
      // 不是标签的 `<`（比如「a < b」）—— 当文字
      pushText(top(), '<')
      i = lt + 1
      continue
    }
    i = lt + m[0].length
    const closing = m[1] === '/'
    const tag = (m[2] ?? '').toLowerCase()
    const rest = m[3] ?? ''

    if (closing) {
      // 往上找最近的同名元素，找到就收到它为止；找不到的闭合标签直接忽略
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]?.tag === tag) {
          stack.length = k
          break
        }
      }
      continue
    }

    if (RAW_DROP.has(tag)) {
      // ⚠️ 不要 `src.toLowerCase().indexOf(…)`：每遇到一个 script 就整串转一遍（平方级），
      // 而且个别字符小写之后长度会变（`İ` → `i̇`），下标就对不上了
      const closeRe = new RegExp(`</${tag}`, 'ig')
      closeRe.lastIndex = i
      const close = closeRe.exec(src)
      if (!close) {
        i = src.length
      } else {
        const end = src.indexOf('>', close.index)
        i = end === -1 ? src.length : end + 1
      }
      continue
    }

    const el: Element = { tag, attrs: parseAttrs(rest), children: [] }
    top().children.push(el)
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) stack.push(el)
  }
  return root
}

/** 一个标签最长多少字符。超过的不当标签（`<img>` 带一条很长的地址也远到不了这里） */
const MAX_TAG_LENGTH = 16 * 1024

/**
 * 从 `<` 开始找这个标签的 `>`（引号里的不算），找不到返回 `-1`。
 *
 * 🔴 **不要把正则直接跑在 `src.slice(lt)` 上**：一个没闭合的 `<`（「a < b」、
 * 被截断的正文）会让它一路扫到串尾，每个 `<` 扫一遍就是平方级 —— 在 Hermes 上
 * 就是详情屏卡住几秒。引号外又碰到 `<` 就说明这不是标签，立刻停。
 */
function tagEnd(src: string, lt: number): number {
  const next = src[lt + 1] ?? ''
  if (!/[a-zA-Z/]/.test(next)) return -1
  const limit = Math.min(src.length, lt + MAX_TAG_LENGTH)
  let quote = ''
  for (let k = lt + 1; k < limit; k++) {
    const c = src[k]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return k
    } else if (c === '<') {
      return -1
    }
  }
  return -1
}

function pushText(parent: Element, raw: string) {
  if (!raw) return
  parent.children.push({ text: decodeEntities(raw) })
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  // ⚠️ 引号写成 `\x22` / `\x27` / `\x60`，不要写字面量：`pnpm i18n:check` 剥注释时不认正则字面量，
  // 正则里落单的引号会让它以为后面整个文件都在字符串里 —— 之后的中文注释全被当成代码扫
  const re = /([^\s\x22\x27=<>/]+)(?:\s*=\s*(?:\x22([^\x22]*)\x22|\x27([^\x27]*)\x27|([^\s\x22\x27=<>\x60]+)))?/g
  for (const m of s.matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase()
    if (!KEPT_ATTRS.has(name)) continue
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', times: '×', copy: '©', reg: '®', trade: '™', bull: '•', laquo: '«', raquo: '»',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // 非法码位（含代理对的半边、超出 Unicode 范围）原样留着，别让 fromCodePoint 抛
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole
      return String.fromCodePoint(code)
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

// ---------------------------------------------------------------------------
// 树 → 块
// ---------------------------------------------------------------------------

type Style = Omit<Inline, 'text'>

function isElement(n: Node): n is Element {
  return 'tag' in n
}

function alignOf(el: Element): Align | undefined {
  const m = /text-align\s*:\s*(left|center|right|justify)/i.exec(el.attrs.style ?? '')
  const v = m?.[1]?.toLowerCase()
  return v === 'center' || v === 'right' || v === 'justify' ? v : undefined
}

function dimension(v: string | undefined): number | undefined {
  const n = v ? Number.parseFloat(v) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 把一串子节点摊成块。行内内容攒进「当前段落」，遇到块级元素就先收掉当前段落。
 *
 * `inPre`：`pre` 里不折叠空白。
 */
function toBlocks(nodes: Node[], inPre: boolean): Block[] {
  const blocks: Block[] = []
  let runs: Inline[] = []

  const flush = () => {
    const cleaned = trimRuns(runs)
    if (cleaned.length) blocks.push({ kind: 'paragraph', runs: cleaned })
    runs = []
  }

  const walkInline = (n: Node, style: Style) => {
    if (!isElement(n)) {
      const text = inPre ? n.text : n.text.replace(/[ \t\n\r\f]+/g, ' ')
      if (text) runs.push({ ...style, text })
      return
    }
    const tag = n.tag
    if (SUBTREE_DROP.has(tag)) return
    if (tag === 'br') {
      runs.push({ ...style, text: '\n' })
      return
    }
    if (tag === 'img') {
      // 行内图片（Tiptap 默认产出块级图，但老数据 / 粘进来的可能在段落里）：
      // RN 的 Text 里放不了按比例缩放的图，所以把它提成独立的块
      flush()
      const img = imageBlock(n)
      if (img) blocks.push(img)
      return
    }
    if (BLOCK_TAGS.has(tag)) {
      // 行内里冒出块级元素（`<span><p>…</p></span>` 这种不规范写法）：照块处理
      flush()
      blocks.push(...blockOf(n, inPre))
      return
    }
    const next: Style = { ...style }
    if (tag === 'strong' || tag === 'b') next.bold = true
    else if (tag === 'em' || tag === 'i' || tag === 'cite') next.italic = true
    else if (tag === 'u' || tag === 'ins') next.underline = true
    else if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true
    else if (tag === 'code' || tag === 'kbd' || tag === 'samp') next.code = true
    else if (tag === 'a' && n.attrs.href) next.href = n.attrs.href.trim()
    for (const c of n.children) walkInline(c, next)
  }

  for (const n of nodes) {
    if (isElement(n) && (BLOCK_TAGS.has(n.tag) || n.tag === 'img')) {
      flush()
      if (n.tag === 'img') {
        const img = imageBlock(n)
        if (img) blocks.push(img)
      } else {
        blocks.push(...blockOf(n, inPre))
      }
    } else {
      walkInline(n, {})
    }
  }
  flush()
  return blocks
}

function blockOf(el: Element, inPre: boolean): Block[] {
  switch (el.tag) {
    case 'p': {
      const inner = toBlocks(el.children, inPre)
      const align = alignOf(el)
      // 正常情况下 p 里只有行内内容 → 恰好一个段落；对齐挂到它上面
      return align ? inner.map((b) => (b.kind === 'paragraph' ? { ...b, align } : b)) : inner
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = el.tag === 'h1' ? 1 : el.tag === 'h2' ? 2 : 3
      const align = alignOf(el)
      return toBlocks(el.children, inPre).map((b) =>
        b.kind === 'paragraph' ? { kind: 'heading' as const, level, runs: b.runs, align } : b,
      )
    }
    case 'ul':
    case 'ol': {
      const items: Block[][] = []
      for (const c of el.children) {
        if (isElement(c) && c.tag === 'li') {
          items.push(compact(toBlocks(c.children, inPre)))
        } else if (isElement(c) || c.text.trim()) {
          // 列表里直接写的文字 / 不规范的子元素：当成一项，不丢内容
          items.push(compact(toBlocks([c], inPre)))
        }
      }
      const nonEmpty = items.filter((it) => it.length)
      if (!nonEmpty.length) return []
      const start = Number.parseInt(el.attrs.start ?? '', 10)
      return [{ kind: 'list', ordered: el.tag === 'ol', start: Number.isFinite(start) ? start : 1, items: nonEmpty }]
    }
    case 'li':
      // 没包在 ul/ol 里的 li：当一项无序列表
      return [{ kind: 'list', ordered: false, start: 1, items: [compact(toBlocks(el.children, inPre))] }]
    case 'blockquote': {
      const children = compact(toBlocks(el.children, inPre))
      return children.length ? [{ kind: 'quote', children }] : []
    }
    case 'pre': {
      const text = textOf(el).replace(/^\n/, '').replace(/\s+$/, '')
      return text ? [{ kind: 'code', text }] : []
    }
    case 'hr':
      return [{ kind: 'rule' }]
    default:
      // div / section / table / tr / td … —— 透明容器，只留内容
      return toBlocks(el.children, inPre)
  }
}

function imageBlock(el: Element): Block | null {
  const src = (el.attrs.src ?? '').trim()
  if (!src) return null
  return {
    kind: 'image',
    src,
    alt: el.attrs.alt ?? '',
    width: dimension(el.attrs.width),
    height: dimension(el.attrs.height),
  }
}

/** 元素里的全部文字（`pre` 用，不折叠空白；`br` 算换行） */
function textOf(n: Node): string {
  if (!isElement(n)) return n.text
  if (n.tag === 'br') return '\n'
  if (SUBTREE_DROP.has(n.tag)) return ''
  return n.children.map(textOf).join('')
}

/**
 * 去掉段首段尾的空白、合并相邻同样式的片段。
 *
 * ⚠️ 只修剪普通空格，**不动 U+00A0**：作者用 `&nbsp;` 顶出来的缩进是有意的。
 */
function trimRuns(runs: Inline[]): Inline[] {
  const merged: Inline[] = []
  for (const r of runs) {
    const prev = merged[merged.length - 1]
    if (prev && sameStyle(prev, r)) prev.text += r.text
    else merged.push({ ...r })
  }
  // 换行两侧的空格（`foo <br> bar`）在原生 Text 里会显示成行首空格
  for (const r of merged) r.text = r.text.replace(/ *\n */g, '\n')
  const first = merged[0]
  if (first) first.text = first.text.replace(/^ +/, '')
  const last = merged[merged.length - 1]
  if (last) last.text = last.text.replace(/ +$/, '')
  const out = merged.filter((r) => r.text !== '')
  // 只剩空白 / 换行的段落（Tiptap 的空行是 `<p></p>`）不占块
  return out.some((r) => r.text.trim() !== '') ? out : []
}

function sameStyle(a: Inline, b: Inline): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.code === !!b.code &&
    a.href === b.href
  )
}

function compact(blocks: Block[]): Block[] {
  return blocks.filter((b) => (b.kind === 'paragraph' || b.kind === 'heading' ? b.runs.length > 0 : true))
}

/**
 * 链接能不能点。只放外部浏览器 / 邮件 / 电话能接的协议 ——
 * `javascript:` / `data:` / `file:` / `intent:` 之类、以及相对地址（那是 web 的路由，
 * 移动端没有对应页面）一律只显示文字。
 */
export function safeLinkHref(href: string | undefined): string | null {
  if (!href) return null
  const h = href.trim()
  return /^(https?:\/\/|mailto:|tel:)/i.test(h) ? h : null
}

/**
 * 图片地址 → 可加载的绝对地址；不该加载的返回 `null`。
 *
 * 正文图是**公开子树**的相对路径（`/uploads/2026/…/x.png`，不鉴权，见
 * `packages/ui/src/components/rich-text/AGENTS.md`），拼上当前服务器地址就能读。
 *
 * 🔴 **只认本服务器**：`//host/…`（协议相对）和第三方 `http(s)` 地址都不加载 ——
 * web 端粘贴时就剥掉了外链图，库里不该有；真有的话，每打开一次都在向第三方
 * 报告「谁在什么时候看了这条公告」。`data:` 也不收（Tiptap 那边 `allowBase64: false`）。
 */
export function resolveImageSrc(src: string, base: string): string | null {
  const s = src.trim()
  if (/^\/(?!\/)/.test(s)) return `${base.replace(/\/+$/, '')}${s}`
  const b = base.replace(/\/+$/, '')
  if (b && (s === b || s.startsWith(`${b}/`))) return s
  return null
}
