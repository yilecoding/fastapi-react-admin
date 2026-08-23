import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { formatDateTime, t as tr } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Separator } from '@admin/ui/components/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'
import { cn } from '@admin/ui/lib/utils'

import { CopyButton, JsonViewer } from '../_shared/json-viewer'
import { StatusPill } from '../_shared/status'
import type { OperaLog } from './index'

const METHOD_CLASS: Record<string, string> = {
  GET: 'text-sky-700 dark:text-sky-300 bg-sky-500/10 ring-sky-500/25',
  POST: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 ring-emerald-500/25',
  PUT: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 ring-amber-500/25',
  DELETE: 'text-destructive bg-destructive/10 ring-destructive/25',
}

/** 归属地：内网 IP 后端会返 "Reserved"，直接显示会很奇怪 */
export function formatLocation(l: Pick<OperaLog, 'country' | 'region' | 'city'>): string {
  const parts = [l.country, l.region, l.city].filter((x) => x && x !== 'Reserved')
  return parts.length ? parts.join(' ') : tr('内网')
}

export function OperaLogDetailSheet({
  open,
  onOpenChange,
  log,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  log: OperaLog | null
}) {
  const { t } = useTranslation()
  if (!log) {
    return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent /></Sheet>
  }

  const ok = log.status === 1
  const uri = log.path

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 基础类里是 data-[side=right]:sm:max-w-sm，带属性选择器优先级更高，
          纯 sm:max-w-* 压不过 —— 覆盖时必须带同样的前缀 */}
      <SheetContent side="right" className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className={cn('inline-flex rounded px-1.5 py-0.5 font-mono text-xs ring-1', METHOD_CLASS[log.method] ?? 'bg-muted ring-border')}>
              {log.method}
            </span>
            {t(log.title)}
          </SheetTitle>
          <SheetDescription>
            {t('操作日志详情。请求头中的凭据类字段已在服务端脱敏，响应体超 10 KB 会被截断。')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          {/* ── 基本信息 ── */}
          <Section title={t("基本信息")}>
            {/* 19 位雪花 ID 与 32 位 trace 放半列里必然折行，单独占整行 */}
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2.5 sm:grid-cols-2">
              <IdRow label={t("日志 ID")} value={log.id} />
              <IdRow label="Trace ID" value={log.trace_id} testId="d-trace" />
            </div>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              <Row label={t("操作人")} value={log.username ?? t('匿名')} />
              <Row label={t("操作时间")} value={formatDateTime(log.opera_time)} mono />
              <Row label={t("操作内容")} value={t(log.title)} />
              <Row label={t("请求方法")} value={log.method} mono />
              <Row label={t("操作 IP")} value={log.ip} mono copy />
              <Row label={t("操作地点")} value={formatLocation(log)} />
              <Row label={t("浏览器")} value={log.browser ?? '—'} />
              <Row label={t("终端系统")} value={`${log.os ?? '—'}${log.device ? ` · ${log.device}` : ''}`} />
              <Row
                label={t("状态")}
                node={
                  <span className="flex items-center gap-1.5">
                    <StatusPill tone={ok ? 'success' : 'danger'}>{ok ? t('成功') : t('异常')}</StatusPill>
                    <Badge variant="outline" className="font-mono font-normal">{log.code}</Badge>
                  </span>
                }
              />
              <Row
                label={t("耗时")}
                node={
                  <span className={cn('font-mono text-sm tabular-nums', log.cost_time > 500 && 'font-medium text-amber-600 dark:text-amber-400')}>
                    {log.cost_time.toFixed(1)} ms
                  </span>
                }
              />
            </dl>

            <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{t('请求 URI')}</span>
              <code className="min-w-0 flex-1 break-all font-mono text-xs" data-testid="d-uri">{uri}</code>
              <CopyButton text={uri} label={t("复制 URI")} />
            </div>

            {log.msg && log.msg !== 'Success' && (
              <p className={cn('mt-2 rounded-md px-3 py-2 text-xs', ok ? 'bg-muted/40 text-muted-foreground' : 'bg-destructive/10 text-destructive ring-1 ring-destructive/25')}>
                {t(log.msg)}
              </p>
            )}
          </Section>

          {/* ── 响应信息 ── */}
          <Section title={t("响应信息")}>
            <Tabs defaultValue="res-headers">
              <TabsList>
                <TabsTrigger value="res-headers" data-testid="tab-res-headers">{t('响应头')}</TabsTrigger>
                <TabsTrigger value="res-body" data-testid="tab-res-body">{t('响应体')}</TabsTrigger>
              </TabsList>
              <TabsContent value="res-headers" className="mt-2">
                <JsonViewer value={log.response_headers} empty={t('未记录响应头')} data-testid="v-res-headers" />
              </TabsContent>
              <TabsContent value="res-body" className="mt-2">
                <JsonViewer
                  value={log.response_body}
                  empty={t('未记录响应体（非 JSON 类响应不记录）')}
                  data-testid="v-res-body"
                />
              </TabsContent>
            </Tabs>
          </Section>

          {/* ── 请求信息 ── */}
          <Section title={t("请求信息")}>
            <Tabs defaultValue="req-headers">
              <TabsList>
                <TabsTrigger value="req-headers" data-testid="tab-req-headers">{t('请求头')}</TabsTrigger>
                <TabsTrigger value="req-args" data-testid="tab-req-args">{t('请求参数')}</TabsTrigger>
                <TabsTrigger value="req-ua" data-testid="tab-req-ua">User-Agent</TabsTrigger>
              </TabsList>
              <TabsContent value="req-headers" className="mt-2">
                <JsonViewer value={log.request_headers} empty={t('未记录请求头')} data-testid="v-req-headers" />
              </TabsContent>
              <TabsContent value="req-args" className="mt-2">
                <JsonViewer
                  value={log.args}
                  empty={t('无请求参数（GET 且无查询串）')}
                  data-testid="v-req-args"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey="含查询参数 / 路径参数 / 请求体，密码类字段已脱敏为 <c>[REDACTED]</c>。"
                    components={{ c: <code /> }}
                  />
                </p>
              </TabsContent>
              <TabsContent value="req-ua" className="mt-2">
                <div className="relative rounded-md border border-border bg-muted/30 p-3 pe-12">
                  <CopyButton text={log.user_agent ?? ''} className="absolute end-2 top-2" />
                  <p className="break-all font-mono text-xs leading-relaxed" data-testid="v-req-ua">
                    {log.user_agent || '—'}
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </Section>
        </div>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" type="button" />}>{t('关闭')}</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
        <span className="shrink-0">{title}</span>
        <Separator className="ms-1 min-w-0 flex-1" />
      </h3>
      {children}
    </section>
  )
}

function IdRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums" title={value} data-testid={testId}>
        {value}
      </code>
      <CopyButton text={value} label={t('复制{{what}}', { what: label })} />
    </div>
  )
}

function Row({
  label, value, node, mono, copy, 'data-testid': testId,
}: {
  label: string
  value?: string | number
  node?: React.ReactNode
  mono?: boolean
  copy?: boolean
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">
        {node ?? (
          <span
            className={cn(
              'min-w-0 text-sm',
              // ID / trace 这类定长值必须完整可见 —— 截断了等于没显示，
              // 所以允许折行而不是 truncate
              mono ? 'font-mono text-xs break-all tabular-nums' : 'truncate'
            )}
            title={String(value ?? '')}
            data-testid={testId}
          >
            {value ?? '—'}
          </span>
        )}
        {copy && value !== undefined && <CopyButton text={String(value)} label={t('复制{{what}}', { what: label })} />}
      </dd>
    </div>
  )
}
