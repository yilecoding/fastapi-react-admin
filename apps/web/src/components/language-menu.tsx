import { IconCheck, IconLanguage } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import { changeLanguage, LANGUAGES, type Language } from "@admin/i18n"
import { Button } from "@admin/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@admin/ui/components/dropdown-menu"

/**
 * 界面语言。
 *
 * 当前语言读 `i18n.language` 而不是 `currentLanguage()` —— react-i18next 会
 * 订阅语言变化并触发重渲染，读快照函数不会。
 *
 * 语言名**不进 t()**：语言列表按惯例各自用本语言书写（英文界面里
 * 「简体中文」仍是「简体中文」），翻译它反而让人找不到自己的语言。
 */
export function LanguageMenu({ className }: { className?: string }) {
  const { t, i18n } = useTranslation()
  const current = i18n.language as Language
  const label = LANGUAGES.find((l) => l.value === current)?.label ?? current

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={className}
            aria-label={t("界面语言")}
            title={t("界面语言")}
            data-testid="language-menu"
          />
        }
      >
        <IconLanguage className="size-4" />
        <span className="text-sm">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuGroup>
          {LANGUAGES.map((l) => (
            <DropdownMenuItem
              key={l.value}
              onClick={() => void changeLanguage(l.value)}
              data-testid={`lang-${l.value}`}
            >
              {l.label}
              {l.value === current && <IconCheck className="ms-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
