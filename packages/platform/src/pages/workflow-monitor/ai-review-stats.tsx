import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { QueryError } from '@admin/ui/components/query-error'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@admin/ui/components/table'
import { formatNumber } from '@admin/i18n'

import { useTabPortalContainer } from '../../shell/tab-outlet'
import { aiReviewStatsQuery, type AiReviewStat } from '../workflow/api'

/**
 * AI 预审一致率（#111 第 5 条「AI 审批节点」要不要做，看的就是这个数）。
 *
 * 口径写在抽屉顶上，和后端 `ai_review_service.agreement_stats` 一字不差 —— 一个没写口径的百分比，
 * 每个人会按自己的理解去读（「需要留意」算没算、被退回的单算几次），拿它做决定就是在赌。
 * 按模型分行：不同模型松紧不一样（真模型实测：同一张单 DeepSeek-V3.2 给通过、Qwen3-VL 给留意），混着算谁的都不是。
 */
export function AiReviewStatsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const container = useTabPortalContainer()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        container={container}
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        data-testid="wf-ai-stats"
      >
        <SheetHeader className="border-b">
          <SheetTitle>{t('AI 预审一致率')}</SheetTitle>
          <SheetDescription>
            {t('AI 的建议和审批人最后的决定对不对得上。决定要不要让 AI 自动同意之前，先看这个数。')}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-4">
          <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground" data-testid="wf-ai-stats-rules">
            <li>{t('每张单只看最后一次预审：被退回重新提交过的，之前的结论已经作废')}</li>
            <li>{t('只算已经通过或驳回的单：撤回、终止、还在审的没有最终决定可比')}</li>
            <li>{t('建议通过最后通过、建议驳回最后驳回，算一致；「需要留意」不算进一致率，单独列出它最后的走向')}</li>
            <li>{t('按模型分开算：不同模型松紧不一样，混在一起的数谁的都不是')}</li>
            <li>{t('AI 自动同意过的单不算：那一步是 AI 定的，不是人的决定')}</li>
            <li>{t('节点上的「AI 自动同意」看的是「建议通过」那一列：人最后也通过的比例够高、单数够多才会替人同意')}</li>
          </ul>
          {open && <StatsTable />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function StatsTable() {
  const { t } = useTranslation()
  const q = useQuery(aiReviewStatsQuery())
  if (q.isPending) return <Skeleton className="h-24 w-full" />
  if (q.isError) {
    return <QueryError error={q.error} onRetry={() => void q.refetch()} title={t('一致率没取到')} testId="wf-ai-stats-error" />
  }
  if (q.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-testid="wf-ai-stats-empty">
        {t('还没有可比的单：要有开了 AI 预审、而且已经通过或驳回的单')}
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('模型')}</TableHead>
            <TableHead>{t('流程')}</TableHead>
            <TableHead className="text-end">{t('一致率')}</TableHead>
            <TableHead className="text-end">{t('建议通过')}</TableHead>
            <TableHead className="text-end">{t('建议驳回')}</TableHead>
            <TableHead className="text-end">{t('需要留意')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.map((r) => (
            <TableRow key={`${r.model ?? ''}:${r.code}`} data-testid={`wf-ai-stats-row-${r.code}`}>
              <TableCell className="font-mono text-xs">{r.model ?? '—'}</TableCell>
              <TableCell>
                <div className="flex flex-col">
                  <span>{r.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                </div>
              </TableCell>
              <TableCell className="text-end tabular-nums" data-testid="wf-ai-stats-agreement">
                {agreementText(r)}
                <span className="block text-xs text-muted-foreground">{t('{{n}} 张可比', { n: formatNumber(r.decided) })}</span>
              </TableCell>
              <Outcome ok={r.pass_approved} other={r.pass_rejected} okLabel={t('通过')} otherLabel={t('驳回')} />
              <Outcome ok={r.reject_rejected} other={r.reject_approved} okLabel={t('驳回')} otherLabel={t('通过')} />
              <Outcome ok={r.attention_approved} other={r.attention_rejected} okLabel={t('通过')} otherLabel={t('驳回')} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 没有可比的单时是「—」，不是 0% —— 两者意思正好相反 */
function agreementText(r: AiReviewStat): string {
  return r.agreement === null ? '—' : `${(r.agreement * 100).toFixed(1)}%`
}

/** 一格里两个数：建议之后最后走向了哪边 */
function Outcome({ ok, other, okLabel, otherLabel }: { ok: number; other: number; okLabel: string; otherLabel: string }) {
  return (
    <TableCell className="text-end text-xs tabular-nums">
      <span className="block">{`${okLabel} ${formatNumber(ok)}`}</span>
      <span className="block text-muted-foreground">{`${otherLabel} ${formatNumber(other)}`}</span>
    </TableCell>
  )
}
