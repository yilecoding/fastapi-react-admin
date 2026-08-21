import type { ReactNode } from 'react'

/**
 * 页头 —— **不再渲染可见的标题栏**。
 *
 * 页名已经写在多页签的 tab 上（`TabBar` 用 `staticData.title`），
 * 页面里再来一行大标题 + 一句说明就是同一个信息占两遍位置：
 * 一屏最值钱的顶部 ~80px 被一句不会有人读第二遍的描述吃掉。
 *
 * 现在只留两样东西：
 * 1. `<h1>` 与描述转成 `sr-only` —— 文档结构与读屏顺序不能因为视觉精简而丢，
 *    `data-testid="page-title"` 也继续可用（E2E 靠它确认落在哪一页）
 * 2. 动作区（新增/导出之类）：**没有动作时整块不渲染**，
 *    否则父容器的 `gap-4/6` 会在页面顶部留一条空档
 *
 * 列表页更推荐把主动作放进 `DataTable` 的 `actions` 槽（和「列」下拉同一行），
 * 连这一行都省掉。
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children?: ReactNode
}) {
  const hasActions = Boolean(children)

  if (!hasActions) {
    return (
      <>
        <h1 className="sr-only" data-testid="page-title">{title}</h1>
        {description && <p className="sr-only">{description}</p>}
      </>
    )
  }

  return (
    // 刻意**不加** px-*：这一行要和页面内容左右对齐。
    // 原来带 `px-1`，于是「刷新」按钮的右边缘是 1980 而所有卡片是 1984 ——
    // 差 4px，肉眼就是「边距怪怪的」（实测确认）。
    // 页面的水平内边距由 `_auth.tsx` 的 `<main className="px-4">` 统一给。
    <div className="flex items-center justify-end gap-2">
      <h1 className="sr-only" data-testid="page-title">{title}</h1>
      {description && <p className="sr-only">{description}</p>}
      {children}
    </div>
  )
}
