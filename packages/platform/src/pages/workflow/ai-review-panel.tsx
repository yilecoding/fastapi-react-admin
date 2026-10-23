import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2, IconRefresh, IconSparkles } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { toast } from '@admin/ui/components/toast'
import { formatDateTime } from '@admin/i18n'

import { StatusPill, type Tone } from '../_shared/status'
import { aiReviewQuery, useRetryAiReview, type AiVerdict, type FormSchema } from './api'

const VERDICT: Record<AiVerdict, { label: string; tone: Tone }> = {
  pass: { label: '建议通过', tone: 'success' },
  attention: { label: '需要留意', tone: 'warning' },
  reject: { label: '建议驳回', tone: 'danger' },
}

/**
 * 审批详情顶上的 AI 预审（#111 第 2 条）。**只供参考**，不影响任何按钮。
 *
 * 🔴 四种状态都要有样子（硬纪律 9）：预审中 / 有结论 / 失败（含超时）+ 重试 / 取不到这条接口。
 * 「失败」绝不能渲染成「没有预审」—— 那会让审批人以为这张单没开预审。
 * 唯一什么都不显示的情况是服务端明确说的：`visible: false`（发起人不该看）或 `status: null`（没开 / 没审过）。
 *
 * 理由已经按查看人裁过（服务端）：引用了他看不到的字段的那几条根本不会下发。
 */
export function AiReviewPanel({ id, schema }: { id: string; schema: FormSchema }) {
  const { t } = useTranslation()
  const q = useQuery(aiReviewQuery(id))
  const retry = useRetryAiReview(id)

  if (q.isPending) return null
  if (q.isError) {
    return (
      <QueryError
        error={q.error}
        onRetry={() => void q.refetch()}
        title={t('AI 预审结果没取到')}
        testId="wf-ai-review-error"
      />
    )
  }
  const r = q.data
  if (!r.visible || r.status === null) return null

  const label = (fieldId: string | null) =>
    fieldId === null ? null : (schema.fields.find((f) => f.id === fieldId)?.label ?? fieldId)

  return (
    <section className="flex flex-col gap-2 rounded-md border bg-muted/30 px-4 py-3" data-testid="wf-ai-review">
      <header className="flex items-center gap-2 text-sm font-medium">
        <IconSparkles className="size-4 text-primary" />
        {t('AI 预审')}
        {r.status === 'done' && r.verdict && (
          <StatusPill tone={VERDICT[r.verdict].tone} data-testid="wf-ai-verdict">
            {t(VERDICT[r.verdict].label)}
          </StatusPill>
        )}
        <span className="ms-auto text-xs font-normal text-muted-foreground">{t('仅供参考，不代替你的判断')}</span>
      </header>

      {r.status === 'pending' && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="wf-ai-pending">
          <IconLoader2 className="size-4 animate-spin" />
          {t('正在预审，通常几十秒内出结果')}
        </p>
      )}

      {(r.status === 'failed' || r.status === 'timeout') && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="wf-ai-failed">
          <span className="text-destructive">
            {r.status === 'timeout' ? t('预审太久没有结果（任务可能没被执行）') : t('预审失败：{{e}}', { e: r.error ?? '' })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            data-testid="wf-ai-retry"
            onClick={() =>
              retry.mutate(undefined, {
                onError: (e) => toast.error(t('重试没成功'), { description: (e as Error).message }),
              })
            }
          >
            {retry.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconRefresh className="size-4" />}
            {t('重新预审')}
          </Button>
        </div>
      )}

      {r.status === 'done' &&
        (r.reasons?.length ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="wf-ai-reasons">
            {r.reasons.map((x, i) => (
              <li key={i} className="flex gap-2">
                {label(x.field_id) && (
                  <span className="shrink-0 rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground">
                    {label(x.field_id)}
                  </span>
                )}
                <span className="whitespace-pre-wrap">{x.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('没有需要特别说明的地方')}</p>
        ))}

      {r.status === 'done' && (
        <p className="text-xs text-muted-foreground">
          {[r.model, r.finished_time ? formatDateTime(r.finished_time) : null].filter(Boolean).join(' · ')}
          {r.superseded ? ` · ${t('之前 {{n}} 次预审已随重新提交作废', { n: r.superseded })}` : ''}
        </p>
      )}
    </section>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('建议通过'), t('需要留意'), t('建议驳回')]
}
