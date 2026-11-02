/**
 * query-error.tsx
 *
 * 取数失败的错误块 —— 全站**唯一一份**。
 *
 * 🔴 存在的理由是硬纪律 9：**请求失败必须是可见状态，不是缺失状态**。
 * 列表页把结果解构成 `data?.items ?? []` 之后，接口 500 和「筛选太窄、
 * 真的没数据」渲染出来是同一个「暂无数据」—— 用户会反复改筛选条件，
 * 而不知道接口挂了。所以失败要**长得和空态不一样**，并且带一个重试入口。
 *
 * 用在三种位置，样式都是这一份：
 *   - 表体里横跨一整行（`DataTableErrorRow`）
 *   - 还有旧数据可看时挂在表格上方当横幅（`DataTable` 的 `error` prop）
 *   - 卡片式页面（仪表盘 / 监控页）直接摆在页头下面
 *
 * 🔴 **原文可能很长，而且常常落在 `whitespace-nowrap` 的单元格里**（#210）。
 * 后端把 SQL / pydantic 报错原样回给 `message`，一条就是几百个字符：
 *   - 表体里（`TableCell` 自带 `whitespace-nowrap`）整句排成一行，横向冲出表格右边，
 *     原来排在最右边的「重试」被一起裁掉 —— 桌面端**看不到重试**，390 宽反而看得到
 *   - 卡片里（仪表盘）几十行竖着铺开，把卡片撑出屏幕
 * 所以：根上显式 `whitespace-normal` + `overflow-wrap:anywhere`，不信任祖先；
 * 「重试」跟着标题走，放在左上，宽表横向滚到哪都在视野里；
 * 原文超过两行先截断，「展开」再看全。
 */
import * as React from "react"
import { IconAlertTriangle, IconChevronDown, IconRefresh } from "@tabler/icons-react"
import { useT } from "../lib/i18n"

import { Button } from "@admin/ui/components/button"

export interface QueryErrorProps {
  /** 原样的查询错误。识别 `ApiError` 的 `httpStatus` / `message`，其它形状回落到「未知错误」 */
  error: unknown
  /** 给了才渲染「重试」按钮（通常是 react-query 的 `refetch`） */
  onRetry?: () => void
  /** 覆盖标题。默认按 403 / 其它两种情形取文案 */
  title?: string
  /** 覆盖第二行的原因。默认是 error.message */
  detail?: string
  testId?: string
  className?: string
}

/** 超过这个长度（或带换行）就先截成两行，给「展开」 */
const LONG_DETAIL = 140

export function QueryError({
  error,
  onRetry,
  title,
  detail,
  testId = "query-error",
  className = "",
}: QueryErrorProps) {
  const t = useT()
  const [expanded, setExpanded] = React.useState(false)
  const e = error as { httpStatus?: number; message?: string } | null
  const forbidden = e?.httpStatus === 403
  const text = detail ?? (forbidden ? t("该接口需要更高的权限。") : (e?.message ?? t("未知错误")))
  const long = text.length > LONG_DETAIL || text.includes("\n")
  return (
    <div
      className={`flex min-w-0 flex-col items-start gap-1.5 rounded-md bg-destructive/10 px-4 py-3 text-start whitespace-normal ring-1 ring-destructive/25 ${className}`}
      data-testid={testId}
      role="alert"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <IconAlertTriangle className="size-4 shrink-0" />
          {title ?? (forbidden ? t("没有权限查看这些数据") : t("数据加载失败"))}
        </p>
        {onRetry && (
          <Button
            variant="outline"
            size="xs"
            className="shrink-0 bg-background"
            onClick={onRetry}
            data-testid={`${testId}-retry`}
          >
            <IconRefresh />
            {t("重试")}
          </Button>
        )}
      </div>
      <p
        className={`max-w-full text-xs text-foreground/70 [overflow-wrap:anywhere] ${long && !expanded ? "line-clamp-2" : "max-h-64 overflow-y-auto whitespace-pre-wrap"}`}
        data-testid={`${testId}-detail`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid={`${testId}-toggle`}
        >
          <IconChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          {expanded ? t("收起") : t("展开详情")}
        </button>
      )}
    </div>
  )
}
