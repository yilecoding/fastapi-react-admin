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
 */
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

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

export function QueryError({
  error,
  onRetry,
  title,
  detail,
  testId = "query-error",
  className = "",
}: QueryErrorProps) {
  const { t } = useTranslation()
  const e = error as { httpStatus?: number; message?: string } | null
  const forbidden = e?.httpStatus === 403
  return (
    <div
      className={`flex flex-col items-start gap-2 rounded-md bg-destructive/10 px-4 py-3 text-start ring-1 ring-destructive/25 sm:flex-row sm:items-center sm:justify-between ${className}`}
      data-testid={testId}
      role="alert"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <IconAlertTriangle className="size-4 shrink-0" />
          {title ?? (forbidden ? t("没有权限查看这些数据") : t("数据加载失败"))}
        </p>
        <p className="text-xs text-destructive/80">
          {detail ?? (forbidden ? t("该接口需要更高的权限。") : (e?.message ?? t("未知错误")))}
        </p>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
          data-testid={`${testId}-retry`}
        >
          <IconRefresh className="size-4" />
          {t("重试")}
        </Button>
      )}
    </div>
  )
}
