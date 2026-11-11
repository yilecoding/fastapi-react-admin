/** `llms-full.txt`：全部文档按分类顺序拼成一个文件，给想一次读完的 AI 用。中文 `/llms-full.txt`，英文 `/en/llms-full.txt`。 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { sectionsOf, text, toMarkdown } from '../../lib/markdown'

export const getStaticPaths: GetStaticPaths = () => [{ params: { locale: undefined } }, { params: { locale: 'en' } }]

export const GET: APIRoute = async ({ params }) => {
  const sections = sectionsOf(await getCollection('docs'), params.locale ?? '')
  return text(sections.flatMap((section) => section.docs.map(toMarkdown)).join('\n---\n\n'))
}
