import { Trans, useTranslation } from 'react-i18next'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@admin/ui/components/dialog'

/**
 * 新建端点 / 重置密钥之后**唯一一次**展示签名密钥（同应用 SK 的 `SecretDialog`）。
 *
 * 🔴 只有「我已保存」能关：`disablePointerDismissal` 挡不住 Esc，所以 `onOpenChange` 什么都不做。
 */
export function WebhookSecretDialog({
  secret,
  rotated,
  onClose,
}: {
  secret: string | null
  /** 重置而来：旧密钥还会一起签 24 小时，要告诉人这一天的窗口 */
  rotated: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={secret !== null} onOpenChange={() => undefined} disablePointerDismissal>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('保存签名密钥')}</DialogTitle>
          <DialogDescription>
            {rotated
              ? t('旧密钥还会一起签名 24 小时（每条消息带两个签名），对方在这一天里换成新的就不会丢事件。')
              : t('交给接收方，用来验证推过去的每一条事件确实是这边发的。关掉之后就再也看不到了，丢了只能重置。')}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
              <code className="min-w-0 flex-1 font-mono text-xs break-all" data-testid="webhook-secret">
                {secret}
              </code>
              <CopyButton text={secret} label={t('复制密钥')} className="size-7 shrink-0" />
            </div>
            <Alert tone="warning">
              <Trans
                t={t}
                i18nKey="签名遵循 Standard Webhooks：校验 <c>webhook-id</c> · <c>webhook-timestamp</c> · <c>webhook-signature</c> 三个请求头。Python / Node / Java 的 <c>verify_webhook</c> 在对接文档里，也可以直接用 Standard Webhooks 各语言的官方库。"
                components={{ c: <code className="font-mono" /> }}
              />
            </Alert>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} data-testid="webhook-secret-saved">
            {t('我已保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
