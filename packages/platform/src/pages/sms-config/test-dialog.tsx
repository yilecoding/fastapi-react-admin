import { useTranslation } from 'react-i18next'
import { IconCheck, IconHelpCircle, IconPlus, IconSend, IconTrash, IconX } from '@tabler/icons-react'
import * as React from 'react'

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
import { Input } from '@admin/ui/components/input'

import { ApiError } from '../../api-client/errors'
import { FormField } from '../_shared/form-fields'
import { ERROR_KIND_LABELS, useTestSmsConfig, type SendResult, type SmsConfig, type SmsProvider } from './api'

/**
 * 发测试短信：选配置 + 号码 + 厂商模板 ID + 厂商侧参数，绕过业务模板，**真发一条**。
 *
 * 这是配置有没有填对的唯一快速验证手段。结果当场显示（状态 + 错误类型 + 厂商码 + 厂商原文），
 * 并写一条 `template = test` 的日志。连不通 / 被拒是**测试结果**不是接口失败 —— 后端照样 200，
 * 这里按 `status` 分三色显示。
 */
export function SmsTestDialog({
  open,
  onOpenChange,
  config,
  provider,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  config: SmsConfig | null
  provider: SmsProvider | null
}) {
  const { t } = useTranslation()
  const test = useTestSmsConfig()
  const [phone, setPhone] = React.useState('')
  const [templateId, setTemplateId] = React.useState('')
  // 按变量名的厂商：[变量名, 值]；按位置的厂商：只用值那一列
  const [params, setParams] = React.useState<[string, string][]>([['code', '123456']])
  const [result, setResult] = React.useState<SendResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const ordered = provider?.template_mapping === 'ordered'

  React.useEffect(() => {
    if (!open) return
    setResult(null)
    setError(null)
    // 配过业务模板的话，把第一个模板的 ID 带出来 —— 大多数时候测的就是它
    const first = config ? Object.values(config.templates)[0] : undefined
    setTemplateId(first?.template_id ?? '')
    if (first && Array.isArray(first.mapping)) setParams(first.mapping.map((p) => [p, p === 'code' ? '123456' : '5']))
    else if (first) setParams(Object.entries(first.mapping).map(([variable, p]) => [variable, p === 'code' ? '123456' : '5']))
    else setParams([['code', '123456']])
  }, [open, config])

  async function send() {
    if (!config) return
    setError(null)
    setResult(null)
    const body = {
      phone: phone.trim(),
      template_id: templateId.trim(),
      params: ordered ? params.map(([, v]) => v) : Object.fromEntries(params.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
    }
    try {
      setResult(await test.mutateAsync({ id: config.id, body }))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('发送失败，请稍后重试'))
    }
  }

  const phoneOk = /^1[3-9]\d{9}$/.test(phone.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="sms-test-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconSend className="size-4" />
            {t('发测试短信')}
            {config ? <span className="text-sm font-normal text-muted-foreground">· {config.name}</span> : null}
          </DialogTitle>
          <DialogDescription>
            {t('绕过业务模板，直接按厂商模板 ID 和参数真发一条；结果会写进发送日志（业务模板记为 test）。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <FormField label={t('收件手机号')} required>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="13800000000" inputMode="numeric" autoComplete="off" data-testid="sms-test-phone" />
          </FormField>
          <FormField label={t('厂商模板 ID')} required hint={provider ? t(provider.template_id_hint) : undefined}>
            <Input value={templateId} onChange={(e) => setTemplateId(e.target.value)} autoComplete="off" maxLength={64} data-testid="sms-test-template" />
          </FormField>

          <FormField
            label={t('模板参数')}
            hint={ordered ? t('按位置：第 1 行对应 {1}，以此类推') : t('按变量名：左边填厂商模板里的变量名，右边填值')}
          >
            <div className="flex flex-col gap-2">
              {params.map(([k, v], i) => (
                <div key={i} className="flex items-center gap-2">
                  {ordered ? (
                    <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{`{${i + 1}}`}</span>
                  ) : (
                    <Input
                      className="w-32"
                      value={k}
                      placeholder={t('变量名')}
                      autoComplete="off"
                      onChange={(e) => setParams((p) => p.map((row, j) => (j === i ? [e.target.value, row[1]] : row)))}
                    />
                  )}
                  <Input
                    value={v}
                    placeholder={t('值')}
                    autoComplete="off"
                    onChange={(e) => setParams((p) => p.map((row, j) => (j === i ? [row[0], e.target.value] : row)))}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 shrink-0"
                    aria-label={t('删除')}
                    onClick={() => setParams((p) => p.filter((_, j) => j !== i))}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setParams((p) => [...p, ['', '']])}>
                <IconPlus className="size-4" />
                {t('加一个参数')}
              </Button>
            </div>
          </FormField>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {result ? <ResultBlock result={result} /> : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('关闭')}</DialogClose>
          <Button type="button" disabled={!phoneOk || !templateId.trim() || test.isPending} onClick={() => void send()} data-testid="sms-test-send">
            <IconSend className="size-4" />
            {test.isPending ? t('发送中…') : t('发送')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResultBlock({ result }: { result: SendResult }) {
  const { t } = useTranslation()
  const tone =
    result.status === 'accepted'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
      : result.status === 'unknown'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
        : 'border-destructive/40 bg-destructive/10 text-destructive'
  const Icon = result.status === 'accepted' ? IconCheck : result.status === 'unknown' ? IconHelpCircle : IconX
  const headline =
    result.status === 'accepted'
      ? t('已受理（厂商已接单，送达看运营商回执）')
      : result.status === 'unknown'
        ? t('结果未知（可能已发出，稍后看发送日志）')
        : t('失败：{{kind}}', { kind: t(ERROR_KIND_LABELS[result.error_kind ?? ''] ?? result.error_kind ?? '') })
  return (
    <div className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-xs ${tone}`} data-testid="sms-test-result">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4" />
        {headline}
        <span className="ms-auto font-normal tabular-nums opacity-70">{result.duration_ms}ms</span>
      </div>
      {result.provider_code ? (
        <div className="font-mono">
          {result.provider_code}
          {result.provider_msg ? ` · ${result.provider_msg}` : ''}
        </div>
      ) : result.provider_msg ? (
        <div className="font-mono">{result.provider_msg}</div>
      ) : null}
      <div className="flex flex-wrap gap-x-3 font-mono opacity-80">
        {result.request_id ? <span>RequestId {result.request_id}</span> : null}
        {result.biz_id ? <span>BizId {result.biz_id}</span> : null}
        {result.log_id ? <span>{t('日志')} {result.log_id}</span> : null}
      </div>
    </div>
  )
}
