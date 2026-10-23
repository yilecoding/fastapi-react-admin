import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconCheck, IconChevronDown, IconLoader2, IconPaperclip, IconSparkles, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Textarea } from '@admin/ui/components/textarea'
import { cn } from '@admin/ui/lib/utils'

import { useAiFill, type AiFill } from './api'

/** 合并之后给人看的：填了几项、已有内容没动几项（由发起页算，面板只负责显示） */
export type AiFillOutcome = { filled: number; kept: number; result: AiFill }

const ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.txt,.md,.csv'

/**
 * 发起页「AI 帮我填」（#111 第 3 条）：粘一段话 / 传一份发票 → 服务端只回值，**合并由发起页做**
 * （只填还空着的字段、标「AI 填的」、跟着草稿存）。这里只管收材料、显示结果。
 */
export function AiFillPanel({ code, onResult }: { code: string; onResult: (res: AiFill) => AiFillOutcome }) {
  const { t } = useTranslation()
  const fill = useAiFill(code)
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [outcome, setOutcome] = React.useState<AiFillOutcome | null>(null)
  const input = React.useRef<HTMLInputElement>(null)

  async function submit() {
    setOutcome(null)
    try {
      const res = await fill.mutateAsync({ text, file })
      setOutcome(onResult(res))
    } catch {
      // 错误挂在面板里（硬纪律 9），材料留着
    }
  }

  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5" data-testid="wf-ai-fill">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="wf-ai-fill-toggle"
      >
        <IconSparkles className="size-4 text-primary" />
        <span className="shrink-0 font-medium">{t('AI 帮我填')}</span>
        <span className="truncate text-xs text-muted-foreground">{t('粘一段话或传一张发票，AI 先填一遍，你逐项核对')}</span>
        <IconChevronDown className={cn('ms-auto size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-primary/15 px-3 py-3">
          <Textarea
            rows={3}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('例如：下周一到周三去上海见客户，坐火车，车票 553 元')}
            data-testid="wf-ai-fill-text"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="wf-ai-fill-file"
            />
            {file ? (
              <span className="flex min-w-0 items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs">
                <IconPaperclip className="size-3.5 shrink-0" />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={t('移除')}
                  onClick={() => {
                    setFile(null)
                    if (input.current) input.current.value = ''
                  }}
                >
                  <IconX className="size-3.5" />
                </button>
              </span>
            ) : (
              <Button variant="outline" size="sm" type="button" onClick={() => input.current?.click()}>
                <IconPaperclip className="size-4" />
                {t('选一份文件（发票图片 / PDF / Word / Excel）')}
              </Button>
            )}
            <Button
              size="sm"
              className="ms-auto"
              onClick={submit}
              disabled={(!text.trim() && !file) || fill.isPending}
              data-testid="wf-ai-fill-submit"
            >
              {fill.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconSparkles className="size-4" />}
              {t('开始填')}
            </Button>
          </div>
          {fill.error && (
            <QueryError error={fill.error} title={t('没有填上')} onRetry={() => void submit()} testId="wf-ai-fill-error" />
          )}
          {outcome && <Summary outcome={outcome} />}
        </div>
      )}
    </div>
  )
}

function Summary({ outcome: { filled, kept, result } }: { outcome: AiFillOutcome }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="wf-ai-fill-summary">
      <p className="font-medium">
        {filled > 0
          ? t('填了 {{n}} 项，下面标了「AI 填的」，请逐项核对', { n: filled })
          : t('材料里没找到能填的内容')}
        {kept > 0 && ` · ${t('已经有内容的 {{n}} 项没动', { n: kept })}`}
      </p>
      {result.note && <p className="text-muted-foreground">{result.note}</p>}
      {result.skipped.length > 0 && (
        <ul className="list-disc ps-4 text-muted-foreground">
          {result.skipped.map((s) => (
            <li key={s.field_id}>{t('{{f}}：{{why}}', { f: s.label, why: s.reason })}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 字段下面那一行：AI 填的、还没核对。改了这个字段也算核对过（发起页那边处理） */
export function AiMark({ onOk }: { onOk: () => void }) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-2 text-xs text-primary" data-testid="wf-ai-mark">
      <IconSparkles className="size-3.5" />
      {t('AI 填的，请核对')}
      <button type="button" className="flex items-center gap-0.5 underline-offset-2 hover:underline" onClick={onOk}>
        <IconCheck className="size-3.5" />
        {t('没问题')}
      </button>
    </span>
  )
}
