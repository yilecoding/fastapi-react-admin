import * as React from "react"
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Label } from "@admin/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/ui/components/select"
import { useT } from "@admin/ui/lib/i18n"
import { cn } from "@admin/ui/lib/utils"

/**
 * 分页条 —— 全站唯一一份。
 *
 * ## 为什么单独拆出来
 *
 * 它原来焊死在两个地方：`DataTable` 里一份、`data-grid/pagination.tsx` 里一份。
 * 两份**行为一致但细节全不一样**，而且都不是故意的：
 *
 * | | DataTable 那份 | data-grid 那份 |
 * |---|---|---|
 * | 每页选项 | `[10, 20, 30, 50]` | `[10, 20, 50, 100]` |
 * | 翻译 | 走 `t()` | **硬编码中文**（在 i18n 的 SKIP_DIRS 里） |
 * | 页码显示 | `第 1 / 9 页` | `1 / 9` |
 * | 已选 N 项 | 有 | 无 |
 *
 * 也就是说同一个产品里有两种分页条，切到沙箱表格就换一种说法。
 * 拆出来之后两边都从这里取 —— 这也正是「自主型库」最该做的事：
 * 下家要改分页条的样子，改一个文件。
 *
 * ## `pageIndex` 是 0 起的
 *
 * 内部一律 0 起（跟 TanStack Table 对齐），显示时 +1。
 * ⚠️ 调用方往 URL 写页码时是 **1 起**、而且「回第一页」要写 `page: undefined`
 * 不是 `page: 1`（见 `_shared/pagination.ts`）—— 两套坐标系的转换在调用方，
 * 本组件不碰 URL。
 */
export type PaginationProps = {
  /** 0 起 */
  pageIndex: number
  pageCount: number
  pageSize: number
  totalCount: number
  onPageChange: (index: number) => void
  onPageSizeChange: (size: number) => void
  pageSizeOptions?: number[]
  /** 给了就把左侧文案换成「已选 N 项 / 共 M 条」。`undefined` = 这张表不支持行选中 */
  selectedCount?: number
  /**
   * testid 前缀。同一屏可能有两个分页条（主从页），不给前缀就撞在一起。
   * 不传则不渲染任何 testid
   */
  testIdPrefix?: string
  className?: string
}

export function Pagination({
  pageIndex,
  pageCount,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 30, 50],
  selectedCount,
  testIdPrefix,
  className,
}: PaginationProps) {
  const t = useT()
  const current = pageIndex + 1
  const last = Math.max(1, pageCount)
  const tid = (name: string) => (testIdPrefix ? `${testIdPrefix}-${name}` : undefined)

  /**
   * 🔴 每页下拉的 id 必须**每个实例都不一样**。
   *
   * 原来这里写死 `id="rows-per-page"`。一屏只有一个表时没事，
   * 但主从页、以及沙箱里「失败 vs 空态」那种并排对比，一屏就有 2~3 个分页条 ——
   * **实测组件沙箱的 DataTable 那一页上 `rows-per-page` 出现了 3 次**。
   *
   * 重复 id 直接废掉 `label htmlFor` ↔ 控件的关联：点「每页」两个字聚焦到的是
   * 文档里**第一个**同 id 的元素，也就是别人的下拉。读屏同理。
   * 而它不报错、不崩，只是点标签没反应 —— 没人会往「id 撞了」上想。
   */
  const autoId = React.useId()
  const sizeId = tid("page-size") ?? `rows-per-page-${autoId}`

  // Base UI 的 Select 关闭态靠 items 映射显示标签，不传会渲染原始 value
  const items = Object.fromEntries(pageSizeOptions.map((s) => [String(s), String(s)]))

  return (
    // shrink-0：表格被撑成滚动视区时，分页条要钉在底部而不是被压扁
    <div
      data-slot="pagination"
      className={cn("flex shrink-0 items-center justify-between gap-3 px-1", className)}
    >
      {/* sm 以下藏掉：窄屏这一行放不下「共 N 条」+ 每页 + 页码 + 四个按钮 */}
      <div
        className="hidden flex-1 text-sm text-muted-foreground sm:flex"
        data-testid={tid("total")}
      >
        {selectedCount === undefined
          ? t("共 {{total}} 条", { total: totalCount })
          : t("已选 {{n}} 项 / 共 {{total}} 条", { n: selectedCount, total: totalCount })}
      </div>

      <div className="flex w-full items-center gap-8 lg:w-fit">
        <div className="hidden items-center gap-2 lg:flex">
          <Label htmlFor={sizeId} className="text-sm font-medium">
            {t("每页")}
          </Label>
          <Select
            value={String(pageSize)}
            items={items}
            onValueChange={(v: string | null) => v && onPageSizeChange(Number(v))}
          >
            {/* size="sm" 而不是 className="h-8" —— 基础类带 data-[size=…] 变体前缀，
                裸 h-8 覆盖不掉（见 ui/AGENTS.md 「为什么有些覆盖无声失效」） */}
            <SelectTrigger
              size="sm"
              className="w-20"
              id={sizeId}
              data-testid={tid("page-size")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div
          className="flex w-fit items-center justify-center text-sm font-medium tabular-nums"
          data-testid={tid("page-indicator")}
        >
          {t("第 {{page}} / {{total}} 页", { page: current, total: last })}
        </div>

        <div className="ms-auto flex items-center gap-2 lg:ms-0">
          {/* 首页 / 末页 在 lg 以下藏掉：小屏够不着的四连按钮不如两个 */}
          <PageButton
            hiddenBelowLg
            label={t("首页")}
            testId={tid("page-first")}
            disabled={current <= 1}
            onClick={() => onPageChange(0)}
          >
            <IconChevronsLeft />
          </PageButton>
          <PageButton
            label={t("上一页")}
            testId={tid("page-prev")}
            disabled={current <= 1}
            onClick={() => onPageChange(pageIndex - 1)}
          >
            <IconChevronLeft />
          </PageButton>
          <PageButton
            label={t("下一页")}
            testId={tid("page-next")}
            disabled={current >= last}
            onClick={() => onPageChange(pageIndex + 1)}
          >
            <IconChevronRight />
          </PageButton>
          <PageButton
            hiddenBelowLg
            label={t("末页")}
            testId={tid("page-last")}
            disabled={current >= last}
            onClick={() => onPageChange(last - 1)}
          >
            <IconChevronsRight />
          </PageButton>
        </div>
      </div>
    </div>
  )
}

function PageButton({
  label,
  testId,
  disabled,
  onClick,
  hiddenBelowLg,
  children,
}: {
  label: string
  testId?: string
  disabled: boolean
  onClick: () => void
  hiddenBelowLg?: boolean
  children: React.ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      // aria-label + sr-only 双写是多余的，图标按钮只要 aria-label
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn("size-8", hiddenBelowLg && "hidden lg:flex")}
    >
      {children}
    </Button>
  )
}
