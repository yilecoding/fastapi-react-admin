import { IconCheck, IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import { Button } from "@admin/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@admin/ui/components/dropdown-menu"
import {
  THEME_MODE_LABELS,
  usePreferences,
  type ThemeMode,
} from "@admin/platform/shell/preferences"

/**
 * 深浅色切换。
 *
 * 状态**不自己存** —— 读写的是 `shell/preferences` 里的 `themeMode`，
 * 和「个人中心 › 偏好设置」是同一个真相源。原来登录页有一套独立的
 * `lib/theme.ts`（存 `admin:theme`），和偏好设置的 `admin:prefs` 两份记录，
 * 在一处改完另一处不知道 —— 已删。
 */
const MODES: ThemeMode[] = ["light", "dark", "system"]

const ICON: Record<ThemeMode, typeof IconSun> = {
  light: IconSun,
  dark: IconMoon,
  system: IconDeviceDesktop,
}

export function ThemeMenu({ className }: { className?: string }) {
  const { t } = useTranslation()
  const mode = usePreferences((s) => s.themeMode)
  const patch = usePreferences((s) => s.patch)
  const Current = ICON[mode]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            aria-label={t("主题模式")}
            title={t("主题模式")}
            data-testid="theme-menu"
          />
        }
      >
        <Current className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuGroup>
          {MODES.map((m) => {
            const Icon = ICON[m]
            return (
              <DropdownMenuItem
                key={m}
                onClick={() => patch({ themeMode: m })}
                data-testid={`theme-${m}`}
              >
                <Icon />
                {t(THEME_MODE_LABELS[m])}
                {m === mode && <IconCheck className="ms-auto size-3.5" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
