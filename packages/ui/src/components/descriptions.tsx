import * as React from "react"

import { CopyButton } from "@admin/ui/components/copy-button"
import { useT } from "@admin/ui/lib/i18n"
import { cn } from "@admin/ui/lib/utils"

/**
 * 键值表 —— 「一列标签 + 一列值」的只读详情。
 *
 * ## 为什么要有这个组件
 *
 * 判据同 `Alert`：**业务层已经在重复写它**。5 个 `detail-sheet` 共 682 行，
 * 每一个都自带一个私有的 `Row`，四份实现三种布局：
 *
 * | 文件 | 布局 | 私有 Row 支持的能力 |
 * |---|---|---|
 * | `log-login` | 标签在左（`w-16`） | `mono` `copy` `node` |
 * | `log-opera` | 标签在左（`w-16`） | `mono` `copy` `node` `data-testid` |
 * | `file` | 标签在上 | `mono` `wrap` |
 * | `scheduler-record` | 带分隔线的两列网格 | `mono` |
 *
 * 全都只差一两个 prop，而且**互相不知道对方的存在** —— 于是「值为空显示什么」
 * 这种小决定在四个文件里有三个答案（`'—'` / `value || '—'` / 原样渲染 undefined）。
 *
 * ## 布局怎么挑
 *
 * | `layout` | 什么时候用 |
 * |---|---|
 * | `inline`（默认） | 标签短、值短。配 `columns={2}` 是详情抽屉的常规形态 |
 * | `stacked` | 值可能很长（路径、校验和、UA），标签在上能给值整行宽度 |
 * | `divided` | 行数多、需要逐行扫读时。分隔线提供横向视线引导 |
 *
 * ⚠️ **`columns={2}` 只在 `sm` 以上生效**，窄屏一律单列 —— 抽屉在手机上
 * 只有 ~320px，两列会让每个值剩不到 100px。
 */

type Layout = "inline" | "stacked" | "divided"

const Ctx = React.createContext<{ layout: Layout; labelWidth: string }>({
  layout: "inline",
  labelWidth: "4rem",
})

export function Descriptions({
  layout = "inline",
  columns = 1,
  labelWidth = "4rem",
  className,
  children,
  ...props
}: React.ComponentProps<"dl"> & {
  layout?: Layout
  /** 列数。窄屏永远是 1 列，这个值从 `sm` 断点起生效 */
  columns?: 1 | 2 | 3
  /** 标签列宽。`inline` / `divided` 用得到，`stacked` 忽略 */
  labelWidth?: string
}) {
  const ctx = React.useMemo(() => ({ layout, labelWidth }), [layout, labelWidth])
  return (
    <Ctx.Provider value={ctx}>
      <dl
        data-slot="descriptions"
        data-layout={layout}
        className={cn(
          layout === "divided"
            ? "flex flex-col"
            : cn(
                "grid grid-cols-1",
                layout === "stacked" ? "gap-x-8 gap-y-4" : "gap-x-8 gap-y-3",
                // 列数写成字面量而不是 `sm:grid-cols-${columns}` —— Tailwind 扫的是
                // 源码里的**完整字符串**，拼出来的类名一条都不会被生成（硬纪律 7 的同族）
                columns === 2 && "sm:grid-cols-2",
                columns === 3 && "sm:grid-cols-3"
              ),
          className
        )}
        {...props}
      >
        {children}
      </dl>
    </Ctx.Provider>
  )
}

export function DescriptionItem({
  label,
  value,
  children,
  mono,
  wrap,
  copy,
  empty,
  span,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  /** 纯文本值。要放 Badge / 状态药丸这类节点就用 `children` */
  value?: string | number | null
  children?: React.ReactNode
  /** 等宽 + 表格数字。ID、IP、时间、哈希都该开 */
  mono?: boolean
  /** 长值换行而不是截断。路径 / 校验和 / UA 这种「截断了等于没显示」的开它 */
  wrap?: boolean
  /** 值右侧加一个复制按钮。只对 `value` 生效（`children` 的文本没法可靠取到） */
  copy?: boolean
  /** 空值占位，默认 `—` */
  empty?: string
  /** 跨列。长值在两列网格里独占一行时用 */
  span?: boolean
}) {
  const t = useT()
  const { layout, labelWidth } = React.useContext(Ctx)
  const text = value === null || value === undefined || value === "" ? "" : String(value)

  const labelEl = (
    <dt
      className={cn(
        "shrink-0 text-xs text-muted-foreground",
        layout === "stacked" ? "mb-1" : null
      )}
      style={layout === "stacked" ? undefined : { width: labelWidth }}
    >
      {label}
    </dt>
  )

  const valueEl = (
    <dd className="flex min-w-0 flex-1 items-center gap-1">
      {children ?? (
        <span
          className={cn(
            "min-w-0 text-sm",
            mono && "font-mono text-xs tabular-nums",
            wrap ? "break-all" : "truncate"
          )}
          title={text || undefined}
        >
          {text || (empty ?? "—")}
        </span>
      )}
      {copy && text ? (
        <CopyButton
          text={text}
          label={t("复制{{what}}", { what: typeof label === "string" ? label : "" })}
        />
      ) : null}
    </dd>
  )

  return (
    <div
      data-slot="description-item"
      className={cn(
        layout === "stacked" && "flex flex-col",
        layout === "inline" && "flex items-baseline gap-2",
        layout === "divided" &&
          "flex items-baseline gap-3 border-b border-border py-2 last:border-b-0",
        span && "sm:col-span-full",
        className
      )}
      {...props}
    >
      {labelEl}
      {valueEl}
    </div>
  )
}
