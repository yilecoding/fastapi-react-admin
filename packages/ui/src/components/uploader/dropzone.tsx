import { IconCloudUpload } from "@tabler/icons-react"
import * as React from "react"

import { useT } from "../../lib/i18n"
import { cn } from "../../lib/utils"

/**
 * 选文件的那个 `<input type="file">`，做成 hook：按钮长什么样由调用方定，
 * input 的 `data-testid` 也由调用方给（E2E 用 `setInputFiles` 打它）。
 *
 * ⚠️ 每次 change 之后都把 `value` 清掉 —— 不清的话连续选**同一个文件**不会再触发 change，
 * 表现是「点了没反应」（用户导入那边踩过）。
 */
export function useFilePicker({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
}: {
  onFiles: (files: File[]) => void
  accept?: string
  multiple?: boolean
  disabled?: boolean
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const inputProps = React.useMemo(
    () => ({
      ref,
      type: "file" as const,
      accept,
      multiple,
      disabled,
      className: "hidden",
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ""
        if (files.length) onFiles(files)
      },
    }),
    [accept, multiple, disabled, onFiles]
  )
  const open = React.useCallback(() => {
    if (!disabled) ref.current?.click()
  }, [disabled])
  return { inputProps, open }
}

/**
 * 拖拽投放区。包住任意内容，拖文件进来时整块盖一层虚线提示，松手就 `onFiles`。
 * 也可以不给 children —— 那就是一块空态式的「拖到这里 / 点击选择」的格子。
 *
 * 嵌套元素的 dragenter / dragleave 会成对乱触发，用计数而不是布尔判「还在不在里面」。
 */
export function Dropzone({
  onFiles,
  onPick,
  disabled = false,
  multiple = true,
  label,
  hint,
  className,
  children,
  testId,
}: {
  onFiles: (files: File[]) => void
  /** 空态格子被点击时（通常接 `useFilePicker().open`）。不给就不可点 */
  onPick?: () => void
  disabled?: boolean
  multiple?: boolean
  label?: React.ReactNode
  hint?: React.ReactNode
  className?: string
  children?: React.ReactNode
  testId?: string
}) {
  const t = useT()
  const depth = React.useRef(0)
  const [dragging, setDragging] = React.useState(false)

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

  const onDragEnter = (e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return
    e.preventDefault()
    depth.current += 1
    setDragging(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }
  const onDrop = (e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) onFiles(multiple ? files : files.slice(0, 1))
  }

  const overlayText = label ?? t("松开即上传")

  if (children === undefined) {
    // 空态格子
    return (
      <button
        type="button"
        disabled={disabled || !onPick}
        onClick={onPick}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        data-dragging={dragging || undefined}
        data-testid={testId}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-muted-foreground transition-colors",
          "hover:border-primary/50 hover:bg-accent/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          "data-[dragging]:border-primary data-[dragging]:bg-primary/5 data-[dragging]:text-foreground",
          className
        )}
      >
        <IconCloudUpload className="size-6" aria-hidden />
        <span className="text-sm">{dragging ? overlayText : (label ?? t("拖文件到这里，或点击选择"))}</span>
        {hint ? <span className="text-xs text-balance">{hint}</span> : null}
      </button>
    )
  }

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-dragging={dragging || undefined}
      data-testid={testId}
    >
      {children}
      {dragging ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80 backdrop-blur-[1px]"
          aria-hidden
        >
          <div className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow">
            <IconCloudUpload className="size-4" />
            {overlayText}
          </div>
        </div>
      ) : null}
    </div>
  )
}
