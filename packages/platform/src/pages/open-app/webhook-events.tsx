import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@admin/ui/components/copy-button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

import { webhookEventsQuery } from './webhook-api'

/** 接收方的最小示例。和 `plugin/open/sdk/python/fra_open_sign.py: verify_webhook` 同一份算法 */
const VERIFY_SNIPPET = `# pip 不用装：把 fra_open_sign.py 拷进项目（对接文档第 4 节）
from fra_open_sign import verify_webhook

@app.post('/receive')
def receive():
    body = request.get_data()          # 原始字节，别先 json.loads
    if not verify_webhook(dict(request.headers), body, 'whsec_…'):
        abort(401)
    event = json.loads(body)
    if seen(request.headers['webhook-id']):   # 至少一次投递：按 webhook-id 去重
        return '', 200
    handle(event['type'], event['data'])      # data 是 thin 的，要详情用 AK/SK 调开放接口
    return '', 200                            # 15 秒内回 2xx，否则按失败重试`

export function WebhookEvents({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const query = useQuery({ ...webhookEventsQuery(), enabled: active })

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="webhook-events-catalog">
      <section className="flex flex-col gap-2">
        <h4 className="font-medium">{t('请求长什么样')}</h4>
        <p className="text-muted-foreground">
          {t('POST JSON：{"type": 事件类型, "timestamp": 发生时间, "data": {…}}。data 只有标识和状态，不含表单内容、手机号、邮箱 —— 要详情用这个应用的 AK/SK 调开放接口。')}
        </p>
        <p className="text-muted-foreground">
          {t('签名：base64(HMAC-SHA256(密钥, "webhook-id.webhook-timestamp.请求体"))，放在 webhook-signature 里（v1, 开头）。顺序不保证，同一事件可能收到不止一次。')}
        </p>
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">{VERIFY_SNIPPET}</pre>
          <CopyButton text={VERIFY_SNIPPET} label={t('复制')} className="absolute top-1.5 right-1.5 size-7" />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="font-medium">{t('可订阅的事件')}</h4>
        {query.error ? (
          <QueryError error={query.error} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="overflow-hidden rounded-md border">
            {query.data.map((e) => (
              <details key={e.type} className="border-b last:border-b-0" data-testid={`webhook-catalog-${e.type}`}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <code className="font-mono text-xs">{e.type}</code>
                  <span>{t(e.label)}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{e.scope}</span>
                </summary>
                <pre className="mx-3 mb-3 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-xs">
                  {JSON.stringify(e.sample, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
