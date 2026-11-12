import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconBook2 } from "@tabler/icons-react"

import { buttonVariants } from "@admin/ui/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@admin/ui/components/tooltip"
import { cn } from "@admin/ui/lib/utils"

import { BRAND } from "@/lib/brand"

/** 演示站顶栏的 DeepWiki 项目解析入口，优先展示 DeepWiki 站点图标。 */
export function DeepWikiLink() {
  const { t } = useTranslation()
  const [iconUnavailable, setIconUnavailable] = React.useState(false)
  const label = t("用 DeepWiki 理解项目")

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={BRAND.deepwikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="deepwiki-link"
            aria-label={label}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-7")}
          />
        }
      >
        {iconUnavailable ? (
          <IconBook2 className="size-4" aria-hidden="true" />
        ) : (
          <img
            src="https://deepwiki.com/favicon.ico"
            alt=""
            aria-hidden="true"
            className="size-4 object-contain"
            onError={() => setIconUnavailable(true)}
          />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
