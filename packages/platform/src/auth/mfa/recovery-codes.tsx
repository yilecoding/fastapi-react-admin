import { IconDownload } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { CopyButton } from '@admin/ui/components/copy-button'

/**
 * 恢复码**只显示这一次**（#181）：手机丢了、认证器删了，靠它登录。每个只能用一次。
 *
 * 给「复制」和「下载 .txt」两条路：让人当场存下来，而不是指望他截图。
 */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation()
  const text = codes.join('\n')

  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="mfa-recovery-codes">
      <Alert tone="warning">
        {t('这些恢复码只显示这一次。手机丢了或认证器删了，用它们登录；每个只能用一次。请存到密码管理器里。')}
      </Alert>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} data-testid="mfa-recovery-code">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <CopyButton text={text} label={t('复制恢复码')} className="size-8" />
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <IconDownload className="size-4" />
          {t('下载')}
        </Button>
      </div>
    </div>
  )
}
