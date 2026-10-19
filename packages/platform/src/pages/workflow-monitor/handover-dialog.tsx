import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { RadioGroup, RadioGroupItem } from '@admin/ui/components/radio-group'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'

import { ApiError } from '../../api-client/errors'
import { FormField as Row } from '../_shared/form-fields'
import { handoverHoldersQuery, idempotencyKey, useHandover } from '../workflow/api'
import { UserSelect } from '../workflow/pickers'

type Result = { moved: number; skipped: { instance_id: string; title: string; reason: string }[] }

/**
 * 离职交接：把一个人手上所有在办的待办交给另一个人。
 *
 * 「交出的人」不用选人控件选：选人控件只列在职的人，而离职的人账号通常已经停用了 ——
 * 这里直接列出「手上有待办的人」（含停用的，标出来）。
 * 交不过去的单（接手的人就是发起人 / 已经在那一步里）逐条列出原因，不是静默跳过。
 */
export function HandoverDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const holders = useQuery({ ...handoverHoldersQuery(), enabled: open })
  const handover = useHandover()
  const [from, setFrom] = React.useState<string | null>(null)
  const [to, setTo] = React.useState<string[]>([])
  const [result, setResult] = React.useState<Result | null>(null)
  // 一次交接 = 一个幂等键：网络抖动重试时已经交过的那些不会再交一遍
  const key = React.useRef(idempotencyKey())

  React.useEffect(() => {
    if (open) {
      setFrom(null)
      setTo([])
      setResult(null)
      key.current = idempotencyKey()
    }
  }, [open])

  async function submit() {
    if (!from || !to[0]) return
    try {
      const res = await handover.mutateAsync({ from_user_id: from, to_user_id: to[0], key: key.current })
      setResult(res)
      if (res.skipped.length === 0) toast.success(t('已交接 {{n}} 条待办', { n: res.moved }))
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('操作失败，请稍后重试'))
    }
  }

  const fromName = holders.data?.find((h) => h.user_id === from)?.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="wf-handover-dialog">
        <DialogHeader>
          <DialogTitle>{t('离职交接')}</DialogTitle>
          <DialogDescription>{t('把一个人手上所有在办的待办交给另一个人处理。已经办完的不受影响。')}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-3 px-4 text-sm" data-testid="wf-handover-result">
            <p>{t('{{from}} 的 {{n}} 条待办已经交出去了。', { from: fromName ?? '', n: result.moved })}</p>
            {result.skipped.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="font-medium text-amber-700 dark:text-amber-400">
                  {t('有 {{n}} 条没交过去，需要单独处理：', { n: result.skipped.length })}
                </p>
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                  {result.skipped.map((s) => (
                    <li key={s.instance_id} className="flex flex-col">
                      <span className="truncate">{s.title}</span>
                      <span className="text-xs text-muted-foreground">{s.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4">
            <Row label={t('交出待办的人')} required>
              {holders.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : holders.error ? (
                <QueryError error={holders.error} onRetry={() => holders.refetch()} />
              ) : holders.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('现在没有人手上有待办')}</p>
              ) : (
                <RadioGroup
                  value={from}
                  onValueChange={(v) => setFrom(String(v))}
                  className="max-h-56 gap-1.5 overflow-y-auto"
                  data-testid="wf-handover-from"
                >
                  {holders.data.map((h) => (
                    <label
                      key={h.user_id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-data-checked:border-primary has-data-checked:bg-primary/5"
                    >
                      <RadioGroupItem value={h.user_id} data-testid={`wf-handover-from-${h.user_id}`} />
                      <span>{h.name}</span>
                      {!h.active && (
                        <span className="rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">{t('已停用')}</span>
                      )}
                      <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                        {t('{{n}} 条待办', { n: h.count })}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              )}
            </Row>
            <Row label={t('接手的人')} required>
              <UserSelect value={to} onChange={setTo} exclude={from ? [from] : undefined} testId="wf-handover-to" />
            </Row>
          </div>
        )}
        <DialogFooter>
          {result ? (
            <DialogClose render={<Button type="button" />}>{t('完成')}</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
              <Button disabled={!from || !to[0] || handover.isPending} onClick={submit} data-testid="wf-handover-submit">
                {handover.isPending && <IconLoader2 className="size-4 animate-spin" />}
                {t('交接')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
