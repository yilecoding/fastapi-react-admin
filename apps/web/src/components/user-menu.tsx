import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { IconCheck, IconLanguage, IconLogout, IconUser, IconUserCircle } from "@tabler/icons-react"

import { meQuery } from "@admin/platform/auth/queries"
import { logout } from "@admin/platform/auth/session"
import { Avatar, AvatarFallback, AvatarImage } from "@admin/ui/components/avatar"
import { Button } from "@admin/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@admin/ui/components/dropdown-menu"
import { toast } from "@admin/ui/components/toast"

import { LANGUAGES, changeLanguage, currentLanguage } from "@/i18n"

export function UserMenu() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: me } = useQuery(meQuery)

  async function handleLogout() {
    try {
      await logout(qc)
    } catch (err) {
      // 没退成：登录态原样留着（见 `logout` 的注释），说清楚、让人再点一次 —— 不能静默停在原地（硬纪律 9）
      const reason = err instanceof Error && err.message ? err.message : String(err)
      toast.error(t('退出登录失败，你仍处于登录状态，请重试：{{reason}}', { reason }), { timeout: 8000 })
      return
    }
    await navigate({ to: "/sign-in", search: { redirect: undefined, reason: undefined } })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" data-testid="user-menu" data-tour="user-menu" />}>
        <Avatar className="size-6">
          {me?.avatar && <AvatarImage src={me.avatar} alt="" />}
          <AvatarFallback className="text-xs">
            {me?.nickname?.slice(0, 1) ?? <IconUserCircle className="size-4" />}
          </AvatarFallback>
        </Avatar>
        <span className="text-sm" data-testid="me-nickname">{me?.nickname ?? "…"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {/* Base UI 要求 DropdownMenuLabel 必须位于 Group 内，否则抛 MenuGroupContext is missing */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{me?.nickname}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {me?.username}{me?.is_superuser ? ` · ${t('超级管理员')}` : ""}
              </span>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {/* 菜单表里「个人中心」是 display=0，不进侧边栏 —— 这里是它唯一的入口 */}
        <DropdownMenuItem
          onClick={() => void navigate({ to: "/profile", search: {} })}
          data-testid="goto-profile"
        >
          <IconUser className="size-4" />
          {t('个人中心')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* 语言切换。切完要同时改 i18next / localStorage / <html lang> /
            接口的 Accept-Language —— 都收在 `@/i18n: changeLanguage` 里 */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
            <IconLanguage className="size-3.5" />
            {t('界面语言')}
          </DropdownMenuLabel>
          {LANGUAGES.map((l) => (
            <DropdownMenuItem
              key={l.value}
              data-testid={`lang-${l.value}`}
              onClick={() => void changeLanguage(l.value)}
            >
              <span className="flex-1">{l.label}</span>
              {currentLanguage() === l.value && <IconCheck className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} data-testid="logout">
          <IconLogout className="size-4" />
          {t('退出登录')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
