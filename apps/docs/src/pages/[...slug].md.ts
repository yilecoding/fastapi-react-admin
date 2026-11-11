/** 每一页文档的 Markdown 原文：页面地址把结尾的 `/` 换成 `.md`（`/features/rbac/` → `/features/rbac.md`）。 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { hasMarkdown, toMarkdown } from '../lib/markdown'

export const getStaticPaths: GetStaticPaths = async () =>
  (await getCollection('docs')).filter(hasMarkdown).map((doc) => ({ params: { slug: doc.id }, props: { doc } }))

export const GET: APIRoute = ({ props }) =>
  new Response(toMarkdown(props.doc), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
