import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconCheck, IconCopy } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { cn } from '@admin/ui/lib/utils'

/**
 * 只读 JSON / 文本查看器，带复制。
 *
 * 不引第三方 JSON 组件：日志里的 payload 已经被后端截断在 10KB 内，
 * `JSON.stringify(…, 2)` 加语法高亮足够看，还省掉一个依赖。
 */
export function JsonViewer({
  value,
  empty,
  className,
  'data-testid': testId,
}: {
  value: unknown
  empty?: string
  className?: string
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  const text = React.useMemo(() => {
    if (value === null || value === undefined || value === '') return ''
    if (typeof value === 'string') {
      // 响应体是字符串，尽量按 JSON 美化；失败就原样显示（可能是截断过的片段）
      try {
        return JSON.stringify(JSON.parse(value), null, 2)
      } catch {
        return value
      }
    }
    return JSON.stringify(value, null, 2)
  }, [value])

  if (!text) {
    return (
      <div className={cn('rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground', className)}>
        {empty ?? t('无内容')}
      </div>
    )
  }

  return (
    <div className={cn('relative rounded-md border border-border bg-muted/30', className)}>
      <CopyButton text={text} className="absolute end-2 top-2" />
      <pre
        data-testid={testId}
        className="max-h-72 overflow-auto p-3 pe-12 font-mono text-xs leading-relaxed"
      >
        <code>{highlight(text)}</code>
      </pre>
    </div>
  )
}

/** 极简语法着色：键名、字符串值、数字/布尔各一色 */
function highlight(src: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\b-?\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push(src.slice(last, m.index))
    if (m[1] && m[2]) {
      parts.push(<span key={i++} className="text-primary">{m[1]}</span>, m[2])
    } else if (m[1]) {
      parts.push(<span key={i++} className="text-emerald-700 dark:text-emerald-300">{m[1]}</span>)
    } else if (m[3]) {
      parts.push(<span key={i++} className="text-amber-700 dark:text-amber-300">{m[3]}</span>)
    } else {
      parts.push(<span key={i++} className="text-muted-foreground">{m[4]}</span>)
    }
    last = re.lastIndex
  }
  if (last < src.length) parts.push(src.slice(last))
  return parts
}

export function CopyButton({
  text,
  className,
  label,
}: {
  text: string
  className?: string
  label?: string
}) {
  const { t } = useTranslation()
  const [done, setDone] = React.useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label ?? t('复制')}
      title={label ?? t('复制')}
      className={cn('size-6 shrink-0', className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // 非安全上下文（http + 非 localhost）没有 clipboard API，退回选中
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? <IconCheck className="size-3.5 text-emerald-600" /> : <IconCopy className="size-3.5" />}
    </Button>
  )
}
