import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconLoader2, IconServer } from "@tabler/icons-react"

import { API_BASE } from "@admin/platform/api-client/client"
import { tryDesktop } from "@admin/platform/desktop"
import { httpUrl } from "@admin/platform/desktop/http-url"
import { Alert } from "@admin/ui/components/alert"
import { Button } from "@admin/ui/components/button"
import { Input } from "@admin/ui/components/input"
import { Label } from "@admin/ui/components/label"

/**
 * 桌面端还没配服务器地址（#392）。
 *
 * 渲染层的 `API_BASE` 在桌面端取的是 `config.json` 的 `serverUrl`（见 platform `api-client/base-url.ts`），
 * 为空时登录页不能照常画表单 —— 验证码、公告会打到 `app://local`，拿回 index.html 的 HTML，
 * 主进程登录则抛「尚未配置服务器地址」，而界面上没有任何地方能填。
 */
export function needsDesktopServer(): boolean {
  return tryDesktop() !== null && !API_BASE
}

/** 末尾不带斜杠，同主进程 `config.ts` 的 normalize；只收完整的 HTTP(S) 地址 */
function normalizeServerUrl(raw: string): string | null {
  const url = httpUrl(raw)
  return url ? url.replace(/\/+$/, "") : null
}

/**
 * 填写 / 更换服务器地址。保存后整页重载：preload 重新同步取 serverUrl，
 * 渲染层 `API_BASE` 和主进程登录用的就是同一个后端。
 */
export function DesktopServerForm({ onCancel }: { onCancel?: () => void }) {
  const { t } = useTranslation()
  const [value, setValue] = React.useState(API_BASE)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const url = normalizeServerUrl(value)
    if (!url) {
      setError(t("请填写完整的服务器地址，以 http:// 或 https:// 开头"))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await tryDesktop()!.config.set({ serverUrl: url })
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("保存失败"))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-4" data-testid="desktop-server-form">
      <div className="grid gap-2">
        <Label htmlFor="desktop-server-url" className="text-sm">{t("服务器地址")}</Label>
        <Input
          id="desktop-server-url"
          data-testid="desktop-server-url"
          className="h-11"
          placeholder="https://admin.example.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          required
        />
        <p className="text-xs text-muted-foreground">
          {t("填后端的访问地址，问系统管理员要。只存在这台电脑上，之后可以在登录页更换。")}
        </p>
      </div>
      {error && (
        <Alert tone="danger" data-testid="desktop-server-error">
          {error}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="h-11 flex-1" disabled={saving} data-testid="desktop-server-save">
          {saving && <IconLoader2 className="size-4 animate-spin" />}
          {t("保存并连接")}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" size="lg" className="h-11" onClick={onCancel} disabled={saving}>
            {t("取消")}
          </Button>
        )}
      </div>
    </form>
  )
}

/** 已配置时在登录页显示当前连的是哪台，并给一个更换入口（连错了、换环境都要能改） */
export function DesktopServerLine({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation()
  if (!tryDesktop() || !API_BASE) return null
  return (
    <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="desktop-server-line">
      <IconServer className="size-3.5 shrink-0" />
      <span className="truncate" title={API_BASE}>
        {API_BASE}
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={onChange}
        className="shrink-0 underline-offset-4 hover:text-foreground hover:underline"
        data-testid="desktop-server-change"
      >
        {t("更换服务器")}
      </button>
    </p>
  )
}
