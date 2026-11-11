/**
 * `llms.txt`：给 AI 助手 / 编码代理的一页索引 —— 每篇文档一行（标题、`.md` 原文地址、一句话说明）。
 * 中文在 `/llms.txt`，英文在 `/en/llms.txt`；全文合并版是同目录的 `llms-full.txt`。
 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { markdownUrl, ROOT, sectionsOf, text } from '../../lib/markdown'

export const getStaticPaths: GetStaticPaths = () => [{ params: { locale: undefined } }, { params: { locale: 'en' } }]

const REPO = 'https://github.com/yilecoding/fastapi-react-admin'

export const GET: APIRoute = async ({ params }) => {
  const locale = params.locale ?? ''
  const en = locale === 'en'
  const docs = await getCollection('docs')
  const home = docs.find((doc) => doc.id === (en ? 'en' : 'index')) ?? docs.find((doc) => doc.id === 'en/index')
  const dir = `${ROOT}${en ? '/en' : ''}`
  const lines = [
    '# fastapi-react-admin',
    '',
    `> ${home?.data.description ?? ''}`,
    '',
    en
      ? `Every page has a Markdown source: replace the trailing \`/\` of its URL with \`.md\`. All pages in one file: ${dir}/llms-full.txt`
      : `每一页都有 Markdown 原文：把页面地址结尾的 \`/\` 换成 \`.md\`。全部文档合并成一个文件：${dir}/llms-full.txt`,
    '',
    en ? `- Source code: ${REPO}` : `- 源码仓库：${REPO}`,
    en
      ? `- Conventions for coding agents live in the repository itself: \`CLAUDE.md\` at the root and an \`AGENTS.md\` in each module directory`
      : `- 给编码代理的约定在仓库里：根目录的 \`CLAUDE.md\`，以及各模块目录下的 \`AGENTS.md\``,
    en ? `- ${'中文'}: ${ROOT}/llms.txt` : `- English: ${ROOT}/en/llms.txt`,
  ]
  for (const section of sectionsOf(docs, locale)) {
    lines.push('', `## ${section.label}`, '')
    for (const doc of section.docs) lines.push(`- [${doc.data.title}](${markdownUrl(doc.id)}): ${doc.data.description ?? ''}`)
  }
  return text(`${lines.join('\n')}\n`)
}
