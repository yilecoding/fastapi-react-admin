import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronUp,
  IconCircleCheck,
  IconFile,
  IconPlayerPause,
  IconRefresh,
  IconSparkles,
  IconX,
} from "@tabler/icons-react"
import * as React from "react"

import { formatBytes, formatSeconds } from "../../lib/format"
import { useT } from "../../lib/i18n"
import { cn } from "../../lib/utils"
import { Button } from "../button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip"

export type UploadTrayStatus =
  | "queued"
  | "hashing"
  | "checking"
  | "uploading"
  | "finalizing"
  | "done"
  | "failed"
  | "canceled"

/** 刷新前没传完、还能接着传的大文件（分片上传）：要用户重新选一下同一个文件 */
export interface UploadTrayResumable {
  id: string
  name: string
  size: number
  /** 已传的比例 0 ~ 1 */
  progress: number
  source?: string | null
}

/** 浮窗只认这一个形状；`platform/src/upload` 的 `UploadItem` 结构上兼容它（ui 不 import 那边） */
export interface UploadTrayItem {
  id: string
  name: string
  size: number
  status: UploadTrayStatus
  /** 0 ~ 1 */
  progress: number
  loaded: number
  speed: number | null
  error: string | null
  /** 秒传命中 */
  reused: boolean
  /** 谁发起的（「文件管理」「附件」），可空 */
  source?: string | null
}

/**
 * 右下角的上传浮窗（Google Drive 那种）。纯展示：标题 / 副栏 / 行都从 `items` 算，
 * 开合、取消、重试全是回调。挂在壳层、页签之外，由 `platform/shell/upload-tray.tsx` 接数据。
 */
export function UploadTray({
  items,
  collapsed,
  etaSeconds,
  onToggle,
  onClose,
  onCancelAll,
  onCancel,
  onRetry,
  onRemove,
  resumable = [],
  onResume,
  onDiscard,
  className,
}: {
  items: readonly UploadTrayItem[]
  resumable?: readonly UploadTrayResumable[]
  /** 「继续」：调用方弹文件选择框，选中同一个文件后接着传 */
  onResume?: (id: string) => void
  /** 「放弃」：删掉服务端已经传上去的那些分片 */
  onDiscard?: (id: string) => void
  collapsed: boolean
  /** 整个队列的剩余秒数；null = 还算不出来 */
  etaSeconds: number | null
  onToggle: () => void
  onClose: () => void
  onCancelAll: () => void
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  className?: string
}) {
  const t = useT()
  const active = items.filter((it) => it.status !== "done" && it.status !== "failed" && it.status !== "canceled").length
  const failed = items.filter((it) => it.status === "failed").length
  const done = items.filter((it) => it.status === "done").length

  const title =
    active > 0
      ? t("正在上传 {{n}} 项内容", { n: active })
      : failed > 0
        ? t("{{n}} 项上传失败", { n: failed })
        : items.length === 0 && resumable.length > 0
          ? t("{{n}} 项上传未完成", { n: resumable.length })
          : t("已上传 {{n}} 项内容", { n: done })

  return (
    <section
      role="status"
      aria-label={title}
      data-testid="upload-tray"
      data-collapsed={collapsed || undefined}
      className={cn(
        "fixed inset-x-2 bottom-2 z-40 overflow-hidden rounded-lg border bg-card text-sm shadow-lg",
        "sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]",
        className
      )}
    >
      <header className="flex items-center justify-between gap-2 bg-muted/60 py-2 pe-1.5 ps-3">
        <span className="truncate font-medium" data-testid="upload-tray-title">
          {title}
        </span>
        <div className="flex shrink-0 items-center">
          <IconButton label={collapsed ? t("展开") : t("折叠")} onClick={onToggle} testId="upload-tray-toggle">
            {collapsed ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
          </IconButton>
          <IconButton label={t("关闭")} onClick={onClose} testId="upload-tray-close">
            <IconX className="size-4" />
          </IconButton>
        </div>
      </header>

      {!collapsed ? (
        <>
          {active > 0 ? (
            <div className="flex items-center justify-between gap-2 border-y bg-primary/5 px-3 py-1.5 text-xs text-muted-foreground">
              <span data-testid="upload-tray-eta">
                {etaSeconds === null ? t("正在计算剩余时间…") : t("还剩 {{eta}}", { eta: formatSeconds(etaSeconds) })}
              </span>
              <button type="button" className="font-medium text-primary hover:underline" onClick={onCancelAll}>
                {t("取消")}
              </button>
            </div>
          ) : null}
          <ul className="max-h-72 divide-y overflow-y-auto overflow-x-hidden">
            {resumable.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2.5 bg-amber-50/60 px-3 py-2 dark:bg-amber-500/5"
                data-testid={`upload-tray-resumable-${r.id}`}
              >
                <IconPlayerPause className="size-4 shrink-0 text-amber-600" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate" title={r.name}>
                    {r.name}
                  </p>
                  {/* 不截断：「重新选择这个文件」是用户唯一要照做的那句，截掉就只剩一个看不懂的「继续」 */}
                  <p className="text-xs text-muted-foreground">
                    {r.source ? `${r.source} · ` : ""}
                    {t("未传完（已传 {{pct}}%），重新选择这个文件即可接着传", { pct: Math.round(r.progress * 100) })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="xs" variant="outline" onClick={() => onResume?.(r.id)} data-testid="upload-tray-resume">
                    {t("继续")}
                  </Button>
                  <IconButton label={t("放弃")} onClick={() => onDiscard?.(r.id)}>
                    <IconX className="size-3.5" />
                  </IconButton>
                </div>
              </li>
            ))}
            {items.map((it) => (
              <TrayRow key={it.id} item={it} onCancel={onCancel} onRetry={onRetry} onRemove={onRemove} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

function TrayRow({
  item,
  onCancel,
  onRetry,
  onRemove,
}: {
  item: UploadTrayItem
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}) {
  const t = useT()
  const pct = Math.round(item.progress * 100)
  const active = item.status !== "done" && item.status !== "failed" && item.status !== "canceled"
  const sub =
    item.status === "uploading"
      ? `${formatBytes(item.loaded)} / ${formatBytes(item.size)}`
      : item.status === "hashing"
        ? t("计算校验和 {{pct}}%", { pct })
        : item.status === "checking"
          ? t("检查是否已上传…")
          : item.status === "finalizing"
            ? t("正在合并分片…")
            : item.status === "queued"
            ? t("等待中")
            : item.status === "failed"
              ? (item.error ?? t("上传失败"))
              : item.status === "canceled"
                ? t("已取消")
                : item.reused
                  ? t("已存在同内容的文件，直接复用")
                  : formatBytes(item.size)

  return (
    <li
      className="group flex items-center gap-2.5 px-3 py-2"
      data-testid={`upload-tray-item-${item.id}`}
      data-status={item.status}
    >
      <IconFile className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate" title={item.name}>
          {item.name}
        </p>
        <p className={cn("truncate text-xs", item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {item.source ? `${item.source} · ` : ""}
          {sub}
        </p>
      </div>
      <div className="relative flex size-6 shrink-0 items-center justify-center">
        {/* 状态图标；hover 时换成动作 */}
        <span className="group-hover:hidden" aria-hidden={active}>
          {item.status === "done" ? (
            item.reused ? (
              <IconSparkles className="size-4 text-emerald-600" />
            ) : (
              <IconCircleCheck className="size-4 text-emerald-600" />
            )
          ) : item.status === "failed" ? (
            <IconAlertCircle className="size-4 text-destructive" />
          ) : item.status === "canceled" ? (
            <IconX className="size-4 text-muted-foreground" />
          ) : (
            <ProgressRing value={item.status === "uploading" || item.status === "hashing" ? item.progress : null} />
          )}
        </span>
        <span className="hidden group-hover:flex">
          {/* 合并中没有按钮：合并在服务端跑，取消拦不住它 —— 显示「已取消」而文件照样落库，比不给按钮更糟 */}
          {item.status === "finalizing" ? null : active ? (
            <IconButton label={t("取消")} onClick={() => onCancel(item.id)}>
              <IconX className="size-3.5" />
            </IconButton>
          ) : item.status === "done" ? (
            <IconButton label={t("移除")} onClick={() => onRemove(item.id)}>
              <IconX className="size-3.5" />
            </IconButton>
          ) : (
            <IconButton label={t("重试")} onClick={() => onRetry(item.id)}>
              <IconRefresh className="size-3.5" />
            </IconButton>
          )}
        </span>
      </div>
    </li>
  )
}

/** 环形进度；`value` 为 null 时转圈（在排队 / 在检查） */
function ProgressRing({ value }: { value: number | null }) {
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 18 18" className={cn("size-4", value === null && "animate-spin")} aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" className="stroke-muted" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-primary"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - (value ?? 0.25))}
        transform="rotate(-90 9 9)"
      />
    </svg>
  )
}

function IconButton({
  label,
  onClick,
  children,
  testId,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  testId?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon" variant="ghost" className="size-7" aria-label={label} onClick={onClick} data-testid={testId} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
