import { useTranslation } from "react-i18next"
import { IconBrandGithub } from "@tabler/icons-react"

import { buttonVariants } from "@admin/ui/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@admin/ui/components/tooltip"
import { cn } from "@admin/ui/lib/utils"

import { BRAND } from "@/lib/brand"

/**
 * 顶栏的仓库入口。之前代码里压根没有一处链回 `BRAND.repoUrl`——
 * 找项目主页只能靠人从别处知道，不是这个页面自己给的路。
 *
 * 放在搜索入口（`CommandTrigger`）和用户菜单之间，跟标签条的图标工具键
 * 同一套样式（`ghost` + `size-7` + Tooltip），不单独占一种视觉语言。
 */
export function GithubLink() {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={BRAND.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="github-link"
            aria-label={t("在 GitHub 上查看源码")}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-7")}
          />
        }
      >
        <IconBrandGithub className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{t("在 GitHub 上查看源码")}</TooltipContent>
    </Tooltip>
  )
}
