import {
  IconAlertCircle,
  IconCheck,
  IconFile,
  IconRefresh,
  IconSparkles,
  IconX,
} from "@tabler/icons-react"
import * as React from "react"

import { formatBytes, formatEta, formatSpeed } from "../../lib/format"
import { useT } from "../../lib/i18n"
import { cn } from "../../lib/utils"
import { Button } from "../button"
import { Progress } from "../progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip"

/**
 * 上传队列的展示。只认这一个形状，不知道队列是谁、接口在哪 ——
 * `platform/upload` 的 `UploadItem` 结构上兼容它。
 */
export type UploadListStatus =
  | "queued"
  | "hashing"
  | "checking"
  | "uploading"
  | "done"
  | "failed"
  | "canceled"

export interface UploadListItem {
  id: string
  name: string
  size: number
  status: UploadListStatus
  /** 0 ~ 1 */
  progress: number
  loaded: number
  speed: number | null
  error: string | null
  /** 秒传命中 */
  reused: boolean
}

const ACTIVE = new Set<UploadListStatus>(["hashing", "checking", "uploading"])
const FINISHED = new Set<UploadListStatus>(["done", "failed", "canceled"])

export function UploadList({
  items,
  onCancel,
  onRetry,
  onRemove,
  onClear,
  compact = false,
  className,
  testId = "upload-list",
}: {
  items: readonly UploadListItem[]
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  onClear: () => void
  /** 附件面板那种窄地方：不显示标题行、字号再小一档 */
  compact?: boolean
  className?: string
  testId?: string
}) {
  const t = useT()
  if (items.length === 0) return null

  const active = items.filter((it) => ACTIVE.has(it.status) || it.status === "queued").length
  const finished = items.filter((it) => FINISHED.has(it.status)).length
  const failed = items.filter((it) => it.status === "failed").length

  return (
    <div
      className={cn("rounded-lg border bg-card", compact ? "text-xs" : "text-sm", className)}
      data-testid={testId}
      aria-live="polite"
    >
      {!compact ? (
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="font-medium">
            {active > 0
              ? t("正在上传 {{active}} 个文件", { active })
              : failed > 0
                ? t("{{failed}} 个文件上传失败", { failed })
                : t("上传完成")}
            {finished > 0 && active > 0 ? (
              <span className="ml-2 font-normal text-muted-foreground">{t("已完成 {{n}}", { n: finished })}</span>
            ) : null}
          </span>
          {finished > 0 ? (
            <Button size="sm" variant="ghost" onClick={onClear} data-testid="upload-clear">
              {t("清除已完成")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ul className={cn("divide-y", compact ? "max-h-40" : "max-h-64", "overflow-y-auto")}>
        {items.map((it) => (
          <UploadRow key={it.id} item={it} compact={compact} onCancel={onCancel} onRetry={onRetry} onRemove={onRemove} />
        ))}
      </ul>
      {compact && finished > 0 && active === 0 ? (
        <div className="flex justify-end px-2 py-1">
          <Button size="xs" variant="ghost" onClick={onClear} data-testid="upload-clear">
            {t("清除已完成")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function UploadRow({
  item,
  compact,
  onCancel,
  onRetry,
  onRemove,
}: {
  item: UploadListItem
  compact: boolean
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}) {
  const t = useT()
  const pct = Math.round(item.progress * 100)
  const active = ACTIVE.has(item.status) || item.status === "queued"

  const statusText: Record<UploadListStatus, string> = {
    queued: t("等待中"),
    hashing: t("计算校验和 {{pct}}%", { pct }),
    checking: t("检查是否已上传…"),
    uploading: [formatBytes(item.loaded), formatSpeed(item.speed), formatEta(item.size - item.loaded, item.speed)]
      .filter(Boolean)
      .join(" · "),
    done: item.reused ? t("已存在同内容的文件，直接复用") : t("已完成"),
    failed: item.error ?? t("上传失败"),
    canceled: t("已取消"),
  }

  const Icon =
    item.status === "done" ? (item.reused ? IconSparkles : IconCheck) : item.status === "failed" ? IconAlertCircle : IconFile
  const iconClass =
    item.status === "done"
      ? "text-emerald-600"
      : item.status === "failed"
        ? "text-destructive"
        : item.status === "canceled"
          ? "text-muted-foreground"
          : "text-primary"

  return (
    <li
      className={cn("flex items-center gap-2.5 px-3", compact ? "py-1.5" : "py-2")}
      data-testid={`upload-item-${item.id}`}
      data-status={item.status}
    >
      <Icon className={cn("size-4 shrink-0", iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium" title={item.name}>
            {item.name}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(item.size)}</span>
        </div>
        {item.status === "uploading" || item.status === "hashing" ? (
          <Progress value={pct} className="mt-1 gap-2" aria-label={t("上传进度")}>
            <span className="sr-only">{pct}%</span>
          </Progress>
        ) : null}
        <p
          className={cn(
            "mt-0.5 truncate text-xs",
            item.status === "failed" ? "text-destructive" : "text-muted-foreground"
          )}
          data-testid="upload-status"
        >
          {statusText[item.status]}
          {item.status === "uploading" ? ` · ${pct}%` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {active ? (
          <IconButton label={t("取消")} onClick={() => onCancel(item.id)}>
            <IconX className="size-3.5" />
          </IconButton>
        ) : (
          <>
            {item.status !== "done" ? (
              <IconButton label={t("重试")} onClick={() => onRetry(item.id)}>
                <IconRefresh className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton label={t("移除")} onClick={() => onRemove(item.id)}>
              <IconX className="size-3.5" />
            </IconButton>
          </>
        )}
      </div>
    </li>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon" variant="ghost" className="size-6" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
