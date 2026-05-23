/**
 * 剥注释。**必须是字符串感知的**，不能用 `/\/\*[\s\S]*?\*\//g` 一把梭。
 *
 * 踩过的两个坑，方向相反，所以两个都得在这一个函数里解决：
 *
 * 1. **裸正则会把字符串里的 `/*` 当注释开头。** `<input accept="image/*" />`
 *    一出现，正则就一路吃到文件里下一个 `*​/`，中间所有 `t('…')` 全部消失。
 *    实测：`profile/index.tsx` 加了 `accept="image/*"` 之后它下面 6 条 key
 *    全被判成「代码里已无此 key」的孤儿 —— 而 `--fix` 会把孤儿从语言包里
 *    **删掉**，英文界面上那几处直接回落中文。missing-keys 也同时瞎掉。
 * 2. **反过来，CSS-in-JS 的注释藏在模板字面量里。** `-sign-in-brand.tsx` 有个
 *    多行 `` `…` `` 装 CSS，里面是 `/* 浅色：… *​/` 这种中文注释。字符串内容
 *    原样保留的话，`jsx-text` 会把它们当成裸露的 JSX 中文文本报出来
 *    （而 jsx-text 原来那几条**逐行**的引号正则，看不见跨行的模板字面量）。
 *
 * 于是分两种模式：
 * - `blankStrings: false`（默认，给 check.mjs）—— 字符串整段原样留着，key 藏在里面
 * - `blankStrings: true`（给 jsx-text.mjs）—— 字符串内容抹成空格，只找字符串**外面**
 *   的中文；模板字面量跨多少行都能抹干净
 *
 * `keepLines: true` 时块注释换成等量空格并保留换行，行号不会错位。
 * `\/` 后面的 `/` 不算行注释开头 —— 正则字面量 `/^https?:\/\/\S+$/` 要靠这条活着。
 */
export function stripComments(src, { keepLines = false, blankStrings = false } = {}) {
  let out = ''
  let i = 0
  const n = src.length
  const pad = (ch) => (ch === '\n' ? '\n' : ' ')

  while (i < n) {
    const c = src[i]

    // ── 字符串 / 模板字面量 ──
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i += 1
      while (i < n) {
        if (src[i] === '\\') {
          const pair = src[i] + (src[i + 1] ?? '')
          out += blankStrings ? pair.replace(/[^\n]/g, ' ') : pair
          i += 2
          continue
        }
        const ch = src[i]
        if (ch === q) {
          out += ch
          i += 1
          break
        }
        out += blankStrings ? pad(ch) : ch
        i += 1
        // 单引号/双引号不跨行：碰到换行就当字符串没闭合，退出去继续正常扫，
        // 免得一个落单的引号把后面整份文件都吃成字符串
        if (ch === '\n' && q !== '`') break
      }
      continue
    }

    // ── 块注释 ──
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        else if (keepLines) out += ' '
        i += 1
      }
      i += 2
      continue
    }

    // ── 行注释 ──
    if (c === '/' && src[i + 1] === '/' && src[i - 1] !== '\\' && src[i - 1] !== ':') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }

    out += c
    i += 1
  }
  return out
}
