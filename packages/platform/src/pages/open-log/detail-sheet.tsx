import { useQuery } from '@tanstack/react-query'
import { IconCheck, IconCode, IconX } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Alert } from '@admin/ui/components/alert'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'
import { Descriptions, DescriptionItem } from '@admin/ui/components/descriptions'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { Can } from '../../auth/can'
import { DetailIdRow, DetailSection } from '../_shared/detail-sheet'
import { JsonViewer } from '../_shared/json-viewer'
import { StatusPill } from '../_shared/status'
import { formatLocation } from '../log-opera/detail-sheet'
import { openAppQuery } from '../open-app/api'
import { ERROR_META, type OpenApiLog } from './shared'

const STATE_TONE = { enabled: 'success', disabled: 'muted', expired: 'warning' } as const
const STATE_LABEL = { enabled: '正常', disabled: '停用', expired: '已过期' } as const

export function OpenApiLogDetailSheet({
  open,
  onOpenChange,
  log,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  log: OpenApiLog | null
}) {
  const { t } = useTranslation()
  if (!log) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent />
      </Sheet>
    )
  }

  const ok = log.status === 1
  const meta = ERROR_META[log.error_code] ?? { label: log.error_code, hint: '' }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 覆盖宽度必须带 data-[side=right] 前缀（ui 分册：纯 sm:max-w-* 压不过基础类） */}
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="inline-flex rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-xs text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-300">
              {log.method}
            </span>
            {t(log.title) || log.path}
          </SheetTitle>
          <SheetDescription>{t('调用详情。凭据类请求头已在服务端脱敏，响应体超 10 KB 会被截断。')}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2" data-testid="open-log-detail">
          <AppCard log={log} />

          <Alert tone={ok ? 'success' : 'danger'} icon={false} className="py-2.5" data-testid="open-log-result">
            <div className="font-medium">
              {t(meta.label)} · {log.code}
            </div>
            {meta.hint ? <div className="mt-0.5 text-xs">{t(meta.hint)}</div> : null}
          </Alert>

          <DetailSection title={t('基本信息')}>
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2.5 sm:grid-cols-2">
              <DetailIdRow label={t('日志 ID')} value={log.id} labelWidth="w-16" />
              <DetailIdRow label="Trace ID" value={log.trace_id} labelWidth="w-16" />
            </div>
            <Descriptions columns={2}>
              <DescriptionItem label={t('调用时间')} value={formatDateTime(log.request_time)} mono />
              <DescriptionItem label={t('接口')} value={`${t(log.title)}${log.scope ? `（${log.scope}）` : ''}`} />
              <DescriptionItem label={t('请求方法')} value={log.method} mono />
              <DescriptionItem label={t('来源 IP')} value={log.ip} mono copy />
              <DescriptionItem label={t('来源地点')} value={formatLocation(log)} />
              <DescriptionItem label={t('客户端')} value={log.browser ?? '—'} />
              <DescriptionItem
                label={t('终端系统')}
                value={`${log.os ?? '—'}${log.device ? ` · ${log.device}` : ''}`}
              />
              <DescriptionItem label={t('状态')}>
                <span className="flex items-center gap-1.5">
                  <StatusPill tone={ok ? 'success' : 'danger'}>{ok ? t('成功') : t('失败')}</StatusPill>
                  <Badge variant="outline" className="font-mono font-normal">
                    {log.code}
                  </Badge>
                </span>
              </DescriptionItem>
              <DescriptionItem label={t('耗时')}>
                <span className="font-mono text-sm tabular-nums">{log.cost_time.toFixed(1)} ms</span>
              </DescriptionItem>
              <DescriptionItem label={t('返回条数')} value={log.row_count === null ? '—' : String(log.row_count)} mono />
            </Descriptions>

            <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{t('请求 URI')}</span>
              <code className="min-w-0 flex-1 break-all font-mono text-xs" data-testid="open-log-uri">
                {uri(log)}
              </code>
              <CopyButton text={uri(log)} label={t('复制 URI')} />
            </div>
          </DetailSection>

          <DetailSection title={t('响应信息')}>
            {/* 失败时先看响应体：签名不匹配的 string_to_sign、时间戳超窗的 server_time 都在里面 */}
            <Tabs defaultValue="res-body">
              <TabsList>
                <TabsTrigger value="res-body">{t('响应体')}</TabsTrigger>
                <TabsTrigger value="res-headers">{t('响应头')}</TabsTrigger>
              </TabsList>
              <TabsContent value="res-body" className="mt-2">
                <JsonViewer value={log.response_body} empty={t('未记录响应体（非 JSON 类响应不记录）')} />
              </TabsContent>
              <TabsContent value="res-headers" className="mt-2">
                <JsonViewer value={log.response_headers} empty={t('未记录响应头')} />
              </TabsContent>
            </Tabs>
          </DetailSection>

          <DetailSection title={t('请求信息')}>
            <Tabs defaultValue="req-headers">
              <TabsList>
                <TabsTrigger value="req-headers">{t('请求头')}</TabsTrigger>
                <TabsTrigger value="req-args">{t('请求参数')}</TabsTrigger>
                <TabsTrigger value="req-ua">User-Agent</TabsTrigger>
              </TabsList>
              <TabsContent value="req-headers" className="mt-2">
                <JsonViewer value={log.request_headers} empty={t('未记录请求头')} />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('x-sign 不打码：它是一次性的请求签名，原样留着方便和服务端算出的签名比对。')}
                </p>
              </TabsContent>
              <TabsContent value="req-args" className="mt-2">
                <JsonViewer value={log.args} empty={t('无请求参数（GET 且无查询串）')} />
              </TabsContent>
              <TabsContent value="req-ua" className="mt-2">
                <div className="relative rounded-md border border-border bg-muted/30 p-3 pe-12">
                  <CopyButton text={log.user_agent ?? ''} className="absolute end-2 top-2" />
                  <p className="break-all font-mono text-xs leading-relaxed">{log.user_agent || '—'}</p>
                </div>
              </TabsContent>
            </Tabs>
          </DetailSection>
        </div>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" type="button" />}>{t('关闭')}</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function uri(log: OpenApiLog): string {
  const query = (log.args?.query_params ?? null) as Record<string, string> | null
  const qs = query ? new URLSearchParams(query).toString() : ''
  return `${log.method} ${log.path}${qs ? `?${qs}` : ''}`
}

/** 调用方应用：快照（调用时）+ 当前配置（现查）。应用被删了或没有查看权限时只显示快照 */
function AppCard({ log }: { log: OpenApiLog }) {
  const { t } = useTranslation()
  return (
    <section
      aria-label={t('调用方应用')}
      className="flex flex-col gap-2.5 rounded-lg border p-3"
      data-testid="open-log-app-card"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <IconCode className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{log.app_name ?? t('（未识别的应用）')}</span>
            {log.app_code ? <code className="font-mono text-xs text-muted-foreground">app:{log.app_code}</code> : null}
            {log.app_id ? (
              <Can perm="open:app:list">
                <CurrentState appId={log.app_id} />
              </Can>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1">
            <code className="font-mono text-xs break-all text-muted-foreground">{log.access_key ?? '—'}</code>
            {log.access_key ? <CopyButton text={log.access_key} label={t('复制 Access Key')} className="size-6" /> : null}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        <Check
          ok={log.scope_granted}
          label={t('本接口需要')}
          value={log.scope ? `${log.scope}${log.scope_granted === false ? t('（未授权）') : log.scope_granted ? t('（已授权）') : ''}` : '—'}
        />
        <Check
          ok={log.ip_whitelisted}
          label={t('来源 IP')}
          value={`${log.ip}${log.ip_whitelisted === false ? t('（不在白名单）') : log.ip_whitelisted ? t('（白名单内）') : ''}`}
        />
        {log.app_id ? (
          <Can perm="open:app:list">
            <CurrentConfig appId={log.app_id} />
          </Can>
        ) : null}
      </div>
    </section>
  )
}

function Check({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {ok === null ? (
        <span className="w-3.5 shrink-0 text-center text-muted-foreground">·</span>
      ) : ok ? (
        <IconCheck className="size-3.5 shrink-0 translate-y-0.5 text-emerald-600" aria-label={t2(true)} />
      ) : (
        <IconX className="size-3.5 shrink-0 translate-y-0.5 text-destructive" aria-label={t2(false)} />
      )}
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  )
}

// 图标的读屏文案不随语言切换无妨（✓/✗ 本身是通用符号），但不能没有
function t2(ok: boolean) {
  return ok ? '✓' : '✗'
}

function useApp(appId: string) {
  return useQuery(openAppQuery(appId))
}

function CurrentState({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const { data, error } = useApp(appId)
  if (error) return <StatusPill tone="muted">{t('应用已删除')}</StatusPill>
  if (!data) return null
  return <StatusPill tone={STATE_TONE[data.state]}>{t(STATE_LABEL[data.state])}</StatusPill>
}

function CurrentConfig({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const { data } = useApp(appId)
  if (!data) return null
  const rows: [string, string][] = [
    [t('已授权接口'), data.scopes.join('、')],
    [t('IP 白名单'), data.ip_whitelist?.join('、') ?? t('不限')],
    [t('限流'), data.rate_per_minute ? t('每分钟 {{n}} 次', { n: data.rate_per_minute }) : t('全局默认')],
    [t('失效时间'), data.expire_time ? formatDateTime(data.expire_time) : t('永不过期')],
  ]
  return (
    <>
      {rows.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-baseline gap-1.5">
          <span className="w-3.5 shrink-0 text-center text-muted-foreground">·</span>
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 break-all">{value}</span>
        </div>
      ))}
    </>
  )
}

