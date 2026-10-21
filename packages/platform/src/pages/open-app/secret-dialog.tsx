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

import { API_BASE } from '../../api-client/client'
import type { IssuedSecret } from './api'

/**
 * 新建 / 重置密钥之后**唯一一次**展示明文 SK。
 *
 * 🔴 关掉就再也拿不到 —— 库里只有密文，而详情接口连密文都不出。所以只有一个「我已保存」按钮，
 * 不给「点遮罩关闭」：误触一下就要重置一次、再去改对方系统的配置（同 MCP 凭据的令牌弹窗）。
 */
export function SecretDialog({ issued, onClose }: { issued: IssuedSecret | null; onClose: () => void }) {
  const { t } = useTranslation()
  // 🔴 按 API_BASE 拼，不是 `window.location.origin`：开发期前后端不同端口（8888 / 8088），
  // 用页面自己的地址会给出一个对方系统根本连不上的 URL。生产同源时 API_BASE 为空，回落到页面地址
  const endpoint = `${API_BASE || window.location.origin}/api/open/v1`
  return (
    // 🔴 onOpenChange 刻意什么都不做：`disablePointerDismissal` 只挡「点遮罩」，**挡不住 Esc** ——
    // 浏览器验收时按一下 Esc 弹窗就没了，SK 再也拿不回来。只有「我已保存」能关
    <Dialog open={issued !== null} onOpenChange={() => undefined} disablePointerDismissal>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('保存这对密钥')}</DialogTitle>
          <DialogDescription>
            {t('交给对接的系统配置。关掉这个窗口之后就再也看不到 Secret Key 了，丢了只能重置。')}
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="space-y-3 text-sm">
            <Field label="Access Key" value={issued.access_key} copyLabel={t('复制 Access Key')} testId="open-ak" />
            <Field label="Secret Key" value={issued.secret_key} copyLabel={t('复制 Secret Key')} testId="open-sk" />
            <Field label={t('接口地址')} value={endpoint} copyLabel={t('复制接口地址')} testId="open-endpoint" />
            <Alert tone="warning">
              <Trans
                t={t}
                i18nKey="每个请求带上 <c>X-Access-Key</c> · <c>X-Timestamp</c> · <c>X-Nonce</c> · <c>X-Sign</c> 四个请求头，签名算法、测试向量和 Python / Java / Node 示例见对接文档。Secret Key 只能放在对方的服务端。"
                components={{ c: <code className="font-mono" /> }}
              />
            </Alert>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} data-testid="open-secret-saved">
            {t('我已保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, copyLabel, testId }: { label: string; value: string; copyLabel: string; testId: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 font-mono text-xs break-all" data-testid={testId}>
          {value}
        </code>
        <CopyButton text={value} label={copyLabel} className="size-7 shrink-0" />
      </div>
    </div>
  )
}
