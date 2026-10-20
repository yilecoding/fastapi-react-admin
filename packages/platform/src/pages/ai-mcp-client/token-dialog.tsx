import { useTranslation } from 'react-i18next'

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
import type { IssuedToken } from './api'

/**
 * 新建 / 重新生成之后**唯一一次**展示明文令牌。
 *
 * 🔴 关掉就再也拿不到 —— 库里只有哈希。所以这里只有一个「我已保存」按钮，
 * 不给「点遮罩关闭」：误触一下就要重新生成一把、再去改对方系统的配置。
 */
export function TokenDialog({ issued, onClose }: { issued: IssuedToken | null; onClose: () => void }) {
  const { t } = useTranslation()
  // 🔴 按 API_BASE 拼，不是 `window.location.origin`：开发期前后端不同端口（8888 / 8088），
  // 用页面自己的地址会给出一个对方系统根本连不上的 URL。生产同源时 API_BASE 为空，回落到页面地址
  const endpoint = `${API_BASE || window.location.origin}/api/v1/ai/mcp`
  return (
    <Dialog open={issued !== null} onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('保存这把令牌')}</DialogTitle>
          <DialogDescription>{t('交给外部系统配置。关掉这个窗口之后就再也看不到明文了。')}</DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="space-y-3 text-sm">
            <Field label={t('令牌')} value={issued.mcp_token} copyLabel={t('复制令牌')} />
            <Field label={t('接口地址')} value={endpoint} copyLabel={t('复制接口地址')} />
            <Alert tone="warning">
              {t('请求头带上 Authorization: Bearer <令牌>，以及 X-Acting-User: <代表的用户名>。')}
            </Alert>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>{t('我已保存')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 font-mono text-xs break-all" data-testid="mcp-token-value">
          {value}
        </code>
        <CopyButton text={value} label={copyLabel} className="size-7 shrink-0" />
      </div>
    </div>
  )
}
