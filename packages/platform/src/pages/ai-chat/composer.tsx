import { IconArrowUp } from '@tabler/icons-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 输入区。
 *
 * 把输入框和发送按钮放进**同一个圆角容器**里，而不是并排两个控件——
 * 并排时视觉上是「一个表单 + 一个按钮」，放进去才读成「一条待发的消息」。
 * 底部那行状态（用哪个模型、能调几个工具）常驻：这两件事决定了回答的质量和边界，
 * 不该藏在别处。
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  streaming,
  modelName,
  toolCount,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  disabled: boolean
  streaming: boolean
  modelName?: string
  toolCount?: number
}) {
  const { t } = useTranslation()
  const ref = React.useRef<HTMLTextAreaElement>(null)

  // 随内容长高，到 160px 封顶后内部滚动。固定两行的话，粘一段长文进去只能看见开头
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])

  const canSend = !disabled && !streaming && value.trim().length > 0

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-2xl border bg-background shadow-sm transition-colors focus-within:border-primary/50">
        <div className="flex items-end gap-2 p-2">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            rows={1}
            placeholder={t('问点什么…')}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) onSend()
              }
            }}
          />
          {/* 圆形发送键：它是这一屏唯一的主动作，做成图标按钮比带文字的更克制 */}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label={t('发送')}
            className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <IconArrowUp className="size-4" />
          </button>
        </div>

        <div className="flex items-center gap-3 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
          {modelName ? <span className="font-mono">{modelName}</span> : null}
          {toolCount !== undefined ? <span>{t('{{n}} 个可用工具', { n: toolCount })}</span> : null}
          <span className="ms-auto">{t('Enter 发送 · Shift+Enter 换行')}</span>
        </div>
      </div>
    </div>
  )
}
