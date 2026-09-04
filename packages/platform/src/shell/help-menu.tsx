import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconCompass, IconHelp, IconKeyboard } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'

import { meQuery } from '../auth/queries'
import { useCommandStore } from './command-store'
import { SHELL_TOUR } from './tour/shell-tour'
import { startTour } from './tour/tour'

/**
 * 顶栏的「帮助」入口（`?` 图标）。
 *
 * 为什么要有它：功能引导原来只有两个入口 —— 首登自动弹一次、⌘K 里搜「功能引导」。
 * 前者只出现一次，后者要先知道有这么一条才搜得到；快捷键清单同理，只有按 `?` 键才到得了。
 * 这两样东西的共同点是「不知道它存在的人正是最需要它的人」，所以要一个**看得见**的按钮，
 * 和顶栏那个印着 ⌘K 的搜索按钮是同一个理由（command-menu.tsx：没被看见的快捷键等于不存在）。
 *
 * 菜单只放两条。将来页面导览（issue #98 阶段 2）加进来时「本页导览」也放这里，
 * 不要在每个页头上各放一个按钮。
 */
export function HelpMenu() {
  const { t } = useTranslation()
  // 「看过了」按人记，所以要 userId（和用户菜单 / ⌘K 同一个 query 缓存）
  const userId = useQuery(meQuery).data?.id
  const setShortcutsOpen = useCommandStore((s) => s.setShortcutsOpen)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            data-testid="help-menu"
            data-tour="help"
            aria-label={t('帮助')}
          />
        }
      >
        <IconHelp className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          data-testid="help-tour"
          disabled={!userId}
          // 让菜单先收起、导览再起。同步启动的话 driver 的遮罩会在同一帧盖住正在关闭的菜单
          onClick={() => {
            if (userId) window.setTimeout(() => startTour(SHELL_TOUR, { userId }), 0)
          }}
        >
          <IconCompass className="size-4" />
          {t('功能引导')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="help-shortcuts" onClick={() => setShortcutsOpen(true)}>
          <IconKeyboard className="size-4" />
          {t('快捷键')}
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
