import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { IconLoader2, IconUpload } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Label } from '@admin/ui/components/label'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { ApiError } from '../../api-client/errors'
import { useInstallPlugin } from './api'

/**
 * 安装插件：zip 上传 或 git 仓库地址。
 *
 * ⚠️ 后端两条路径都写死了 `if settings.ENVIRONMENT != 'dev': raise` ——
 * 非开发环境**一定失败**。这里不预先隐藏入口（隐藏等于把「功能不存在」和
 * 「环境不允许」混为一谈），而是把后端的原话显示出来。
 */
export function InstallSheet({
  open, onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = React.useState<'zip' | 'git'>('zip')
  const [file, setFile] = React.useState<File | null>(null)
  const [repoUrl, setRepoUrl] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [okMsg, setOkMsg] = React.useState<string | null>(null)
  const install = useInstallPlugin()

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setOkMsg(null)
  }, [open])

  const gitOk = /^(https?:\/\/|git@)\S+$/.test(repoUrl.trim())
  const ready = tab === 'zip' ? file !== null : gitOk

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setOkMsg(null)
    try {
      const res = (await install.mutateAsync(
        tab === 'zip' ? { type: 'zip', file: file! } : { type: 'git', repoUrl: repoUrl.trim() }
      )) as { msg?: string } | null
      // 后端把「装好了但要配置 + 重启」写在 msg 里，原样转达比自己编一句有用
      setOkMsg(res?.msg ?? t('安装成功，请按插件说明配置并重启服务'))
      setFile(null)
      setRepoUrl('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('安装失败'))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('安装插件')}</SheetTitle>
          <SheetDescription>
            <Trans
              t={t}
              i18nKey="装完需要按插件的 README 配置并<b>重启后端服务</b>才会生效。后端限制此操作仅在开发环境可用。"
              components={{ b: <strong /> }}
            />
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={submit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <Tabs value={tab} onValueChange={(v) => { setTab(v as 'zip' | 'git'); setError(null); setOkMsg(null) }}>
              <TabsList variant="line" data-testid="install-tabs">
                <TabsTrigger value="zip" data-testid="install-tab-zip">{t('ZIP 压缩包')}</TabsTrigger>
                <TabsTrigger value="git" data-testid="install-tab-git">{t('Git 仓库')}</TabsTrigger>
              </TabsList>

              <TabsContent value="zip" className="flex flex-col gap-2 pt-4">
                <Label htmlFor="i-file">{t('插件压缩包')}</Label>
                <Input
                  id="i-file" type="file" accept=".zip" data-testid="i-file"
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); setOkMsg(null) }}
                />
                {file && (
                  <p className="text-xs text-muted-foreground" data-testid="i-file-name">
                    {t('已选择 {{name}}（{{kb}} KB）', { name: file.name, kb: (file.size / 1024).toFixed(0) })}
                  </p>
                )}
              </TabsContent>

              <TabsContent value="git" className="flex flex-col gap-2 pt-4">
                <Label htmlFor="i-repo">{t('Git 仓库地址')}</Label>
                <Input
                  id="i-repo" data-testid="i-repo" value={repoUrl}
                  placeholder="https://github.com/user/fba-plugin-xxx.git"
                  onChange={(e) => { setRepoUrl(e.target.value); setError(null); setOkMsg(null) }}
                />
                {repoUrl && !gitOk && (
                  <p className="text-xs text-destructive">{t('请填 http(s):// 或 git@ 开头的完整地址')}</p>
                )}
              </TabsContent>
            </Tabs>

            {error && (
              <p className="text-sm text-destructive" data-testid="install-error">{error}</p>
            )}
            {okMsg && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400" data-testid="install-ok">{okMsg}</p>
            )}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={!ready || install.isPending} data-testid="i-submit">
              {install.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconUpload className="size-4" />}
              {t('安装')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('关闭')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
