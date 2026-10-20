import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconAlertTriangle, IconCircleCheck, IconCircleX } from '@tabler/icons-react'
import * as React from 'react'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { api } from '../../api-client/client'
import { ApiError } from '../../api-client/errors'
import { streamChat, type AgentEvent } from '../ai-chat/api'

export type AiConfirmSearch = { token?: string }

type Pending = { tool: string; preview: string; channel: string | null; expires_in: number }

/**
 * 回网页确认一个由外部系统（MCP）发起的写操作。
 *
 * 🔴 **这一页就是「本人确认」的那一步**：外部系统声明了「代表张三」，只有张三本人登录
 * 打开这个链接、点确认，操作才会执行（后端校验令牌归属，别人打开只看到「不属于你」）。
 * 所以页面只做两件事：把「会变成什么」原样摆出来，给一个确认按钮。
 */
export function AiConfirmPage({ search = {} }: { search?: AiConfirmSearch; onSearchChange?: (n: AiConfirmSearch) => void }) {
  const { t } = useTranslation()
  const token = search.token
  const pending = useQuery({
    queryKey: ['ai-confirm', token],
    queryFn: () => api.GET<Pending>(`/api/v1/ai/chat/tools/confirm/${token}`),
    enabled: !!token,
    retry: false,
    // 令牌一次性：确认之后再取就是 404，别让窗口重新聚焦时把成功页刷成「已过期」
    refetchOnWindowFocus: false,
  })
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [running, setRunning] = React.useState(false)

  async function confirm() {
    if (!token) return
    setRunning(true)
    try {
      await streamChat('/api/v1/ai/chat/tools/confirm', { token }, (e: AgentEvent) => {
        if (e.type === 'tool_result') setResult({ ok: e.ok, text: e.summary })
        if (e.type === 'error') setResult({ ok: false, text: e.message })
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-1 justify-center py-8">
      <div className="w-full max-w-xl space-y-4">
        {!token ? (
          <Alert tone="danger">{t('链接里没有确认令牌，请从外部系统给出的完整链接打开。')}</Alert>
        ) : isSettled(pending.error) ? (
          // 已过期 / 已处理 / 不属于你：都是终态，给「重试」只会让人反复点一个永远不会成功的按钮
          <Alert tone="info" data-testid="ai-confirm-gone">
            {pending.error.message}
          </Alert>
        ) : pending.error ? (
          <QueryError error={pending.error} onRetry={() => pending.refetch()} />
        ) : pending.isPending ? (
          <Skeleton className="h-48" />
        ) : result ? (
          <div className="flex items-start gap-3 rounded-lg border p-4" data-testid="ai-confirm-result">
            {result.ok ? (
              <IconCircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" />
            ) : (
              <IconCircleX className="mt-0.5 size-5 shrink-0 text-destructive" />
            )}
            <div className="space-y-1">
              <p className="font-medium">{result.ok ? t('已执行') : t('没有执行')}</p>
              <p className="text-sm text-muted-foreground">{result.text}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 rounded-lg border border-amber-300/70 bg-amber-50/60 p-5 dark:border-amber-800/60 dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <p className="font-medium">{t('这个操作会改变系统数据')}</p>
                <p className="text-sm text-muted-foreground">
                  {pending.data.channel
                    ? t('由外部系统 {{channel}} 以你的身份发起，只有你点确认才会执行。', { channel: pending.data.channel })
                    : t('只有你点确认才会执行。')}
                </p>
              </div>
            </div>
            <pre className="overflow-x-auto rounded bg-background/70 p-3 font-mono text-xs whitespace-pre-wrap" data-testid="ai-confirm-preview">
              {pending.data.preview}
            </pre>
            <div className="flex items-center gap-3">
              <Button onClick={() => void confirm()} disabled={running}>
                {t('确认执行')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('{{n}} 秒内有效；不确认就什么都不会发生', { n: pending.data.expires_in })}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 404（过期 / 用过了）和 403（不是你的）是终态；只有网络、5xx 之类才值得重试。
 *  ⚠️ 两个都要看：FBA 的业务失败可能是 HTTP 200 + bizCode（`packages/api` 分册） */
function isSettled(error: unknown): error is ApiError {
  return error instanceof ApiError && [403, 404].some((c) => error.httpStatus === c || error.bizCode === c)
}
