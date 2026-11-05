import type * as React from 'react'

import { cn } from '@admin/ui/lib/utils'

/**
 * 页面外壳：所有业务页最外面那几层 div，收在这一个地方（#209）。
 *
 * ⚠️ **这里不给上下 padding，页面里也不给。** 四边 16px 统一由外壳的内容列
 * （`apps/web/src/routes/_auth.tsx` 上 `data-slot="content-scroll"` 那层的 `p-4`）
 * 一次给齐 —— 和「页面级块一律不加 `px-*`」是同一条纪律，补上了竖直方向。
 * 原来每页手抄 `py-4 md:py-6`（shadcn dashboard 模板带来的，那个模板没有标签条），
 * 抄漏的页查询区直接贴标签条、抄成 `py-3` 的又是 12px，全站三种顶距。
 * `pnpm arch:check` 的 `page-shell` 规则守着这条。
 *
 * `fill` 决定「内容区滚动」模式下这一块要不要撑满可用高度：
 *
 * - `always` —— 列表页。撑满之后里面的表格框变成定高视区：筛选栏 / 表头 / 分页条钉住，
 *   只有行滚。整页滚动模式下祖先高度是 auto，这两条是空操作（见 ui/data-table.tsx 的注释）
 * - `lg` —— 主从页。宽屏两栏各自成定高视区，窄屏上下堆叠时照旧整块滚
 * - `none` —— 监控 / 卡片 / 演示页，按自然高度排
 *
 * 三层缺一不可：最外层接住外壳的 flex 收缩链；中间层是 `@container/main`
 * （仪表盘等按**容器**宽度断点，不按视口）；最里层才是页面块之间的 gap。
 */
export function PageShell({
  fill = 'none',
  className,
  children,
}: {
  fill?: 'always' | 'lg' | 'none'
  /** 加在最里层（页面块所在那层）上，比如 `flex-1` 让内容撑满、或改块间距 */
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col content-scroll:min-h-0">
        <div
          data-slot="page-shell"
          className={cn(
            'flex flex-col gap-4 md:gap-6',
            fill === 'always' && 'content-scroll:min-h-0 content-scroll:flex-1',
            fill === 'lg' && 'flex-1 content-scroll:lg:min-h-0 content-scroll:lg:flex-1',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * 列表页的「查询区 + 表格」那一块：两者是同一件事的两半（筛选 → 结果），包成一块。
 *
 * - **`gap-3`（12px）**：介于查询区内部的 8px 和页面块之间的 16 / 24px 之间，组内组间分得开又不松。
 *   原来 14 个 `QueryBar` 页各写一份 `gap-4`，部门 / 菜单两个树表页干脆没包、筛选行到表格吃的是
 *   页面级的 24px；8 / 12 / 16 截图对比后定了 12（`DataTable` 自带工具栏那条路同值）。要调就只改这里
 * - **`content-scroll:min-h-0 content-scroll:flex-1`**：「只滚表格行」那条收缩链从外壳一直到 `<table>`，
 *   断一层就整条失效（表现是「设置生效了，但还是整块在滚」）
 */
export function ListBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div data-slot="list-body" className={cn('flex flex-col gap-3 content-scroll:min-h-0 content-scroll:flex-1', className)}>
      {children}
    </div>
  )
}
