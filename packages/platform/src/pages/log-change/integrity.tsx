import * as React from 'react'
import { IconShieldCheck } from '@tabler/icons-react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { type DataChangeIntegrity, type DataChangeIntegrityProblem, verifyDataChanges } from '../_shared/data-change/api'

function useProblemText(): (p: DataChangeIntegrityProblem) => string {
  const { t } = useTranslation()
  return (p) => {
    const range = { from: p.seq ?? '?', to: p.seq_to ?? '?' }
    switch (p.kind) {
      case 'modified':
        return t('第 {{seq}} 条的内容被改过', { seq: p.seq })
      case 'missing':
        return t('第 {{from}} – {{to}} 条被删掉了', range)
      case 'tail':
        return t('最新的记录被删掉了（第 {{from}} – {{to}} 条），或者链头被改过', range)
      case 'key':
        return t('第 {{seq}} 条的签名密钥对不上', { seq: p.seq })
      case 'unchained':
        return t('这一条不在链上：没经过应用、直接写进表里的')
      case 'head':
        return t('链头那一行不见了')
    }
  }
}

function Result({ report }: { report: DataChangeIntegrity }) {
  const { t } = useTranslation()
  const text = useProblemText()
  const range = { from: report.anchor_seq + 1, to: report.head_seq, n: report.checked }
  return (
    <div className="flex flex-col gap-3" data-testid="integrity-result" data-ok={report.ok}>
      {report.ok ? (
        <Alert tone="success" title={t('没有发现问题')}>
          {t('第 {{from}} – {{to}} 条，共 {{n}} 条，签名都对得上：没有被改过、删过，也没有绕过应用塞进来的', range)}
        </Alert>
      ) : (
        <Alert tone="danger" title={t('发现 {{n}} 个问题', { n: report.problem_count })}>
          <ul className="flex flex-col gap-1.5" data-testid="integrity-problems">
            {report.problems.map((p, i) => (
              <li key={i} data-kind={p.kind}>
                <span>{text(p)}</span>
                {p.record_id && (
                  <span className="ms-2 font-mono text-xs text-muted-foreground">
                    {p.record_id}
                    {p.created_time && ` · ${formatDateTime(p.created_time)}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {report.problem_count > report.problems.length && (
            <p className="mt-1 text-muted-foreground">
              {t('还有 {{n}} 个没列出来', { n: report.problem_count - report.problems.length })}
            </p>
          )}
        </Alert>
      )}
      {!report.keyed && (
        <Alert tone="warning" data-testid="integrity-no-key">
          {t(
            '没配签名密钥（DATA_CHANGE_CHAIN_KEY）：直接改库能发现，但挡不住读过代码、会自己重算签名的人。在后端的 .env 里配一个，配了就别换'
          )}
        </Alert>
      )}
      {report.other_key > 0 && (
        <Alert tone="info">
          {t('有 {{n}} 条是换密钥之前签的，现在的密钥校验不了', { n: report.other_key })}
        </Alert>
      )}
      {report.anchor_seq > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('第 {{n}} 条及之前的已经过了保留期、被清理掉了，不在校验范围里', { n: report.anchor_seq })}
        </p>
      )}
    </div>
  )
}

/**
 * 「校验完整性」（#260 防篡改链）：从头重算每一条记录的签名，看有没有被改过、删过、绕过应用塞进来过。
 *
 * 只给超管（接口也是 `DependsSuperUser`）。记录多时要几秒，所以是点了才跑，不是进页面就查。
 * 图标按钮不用 `disabled` 挡重复点击（`ui` 分册：禁用了 tooltip 就打不开），在途时转圈 + 重入守卫。
 */
export function IntegrityCheck() {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const verify = useMutation({ mutationFn: verifyDataChanges })

  const run = () => {
    setOpen(true)
    if (!verify.isPending) verify.mutate()
  }

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className="size-8 p-0"
      aria-label={t('校验完整性')}
      aria-busy={verify.isPending}
      data-testid="integrity-check"
      onClick={run}
    />
  )
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={trigger}>
          <IconShieldCheck className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t('校验完整性')}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-testid="integrity-dialog">
          <DialogHeader>
            <DialogTitle>{t('校验完整性')}</DialogTitle>
            <DialogDescription>
              {t('每一条记录写进去时都签了名，签名里带着上一条的签名。这里从头重算一遍')}
            </DialogDescription>
          </DialogHeader>
          {verify.isPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('正在从头重算签名…')}</p>
          ) : verify.error ? (
            <QueryError error={verify.error} onRetry={() => verify.mutate()} />
          ) : verify.data ? (
            <Result report={verify.data} />
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>
              {t('再校验一次')}
            </Button>
            <DialogClose render={<Button />}>{t('关闭')}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
