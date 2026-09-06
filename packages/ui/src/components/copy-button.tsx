import * as React from "react"
import { IconCheck, IconCopy } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { useT } from "@admin/ui/lib/i18n"
import { cn } from "@admin/ui/lib/utils"

/**
 * 「复制到剪贴板」图标按钮。复制成功给 1.4 秒的对勾回执，不弹 toast ——
 * 复制这个动作的反馈应该在原地，弹一个全局提示是过度打断。
 *
 * 🔴 **必须带 `document.execCommand` 兜底。** `navigator.clipboard` 只在
 * **安全上下文**（https，或 localhost）下存在。局域网 http 访问后台是这类系统
 * 最常见的部署形态，那时 `navigator.clipboard` 是 `undefined`，
 * `await navigator.clipboard.writeText()` 直接抛 TypeError —— 而按钮的回执
 * 逻辑在 `await` 之后，于是**点了没有任何反应**，看着像按钮坏了。
 */
export function CopyButton({
  text,
  className,
  label,
}: {
  text: string
  className?: string
  label?: string
}) {
  const t = useT()
  const [done, setDone] = React.useState(false)

  // 卸载后不再 setState —— 复制完 1.4 秒内把抽屉关掉是很常见的操作
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label ?? t("复制")}
      title={label ?? t("复制")}
      className={cn("size-6 shrink-0", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // 非安全上下文（http + 非 localhost）没有 clipboard API，退回选中
          const ta = document.createElement("textarea")
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand("copy")
          ta.remove()
        }
        if (!alive.current) return
        setDone(true)
        setTimeout(() => alive.current && setDone(false), 1400)
      }}
    >
      {done ? (
        <IconCheck className="size-3.5 text-emerald-600" />
      ) : (
        <IconCopy className="size-3.5" />
      )}
    </Button>
  )
}
