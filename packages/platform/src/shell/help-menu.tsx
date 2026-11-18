import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconCompass, IconHelp, IconInfoCircle, IconKeyboard } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'

import { AboutDialog, type AboutInfo } from './about-dialog'
import { useCommandStore } from './command-store'
import { SHELL_TOUR } from './tour/shell-tour'
import { startTour } from './tour/tour'

/**
 * 顶栏的「帮助」入口（`?` 图标）。
 *
 * 为什么要有它：功能引导不自动弹，另一个入口是 ⌘K 里搜「功能引导」——
 * 要先知道有这么一条才搜得到；快捷键清单同理，只有按 `?` 键才到得了。
 * 这两样东西的共同点是「不知道它存在的人正是最需要它的人」，所以要一个**看得见**的按钮，
 * 和顶栏那个印着 ⌘K 的搜索按钮是同一个理由（command-menu.tsx：没被看见的快捷键等于不存在）。
 *
 * 「关于」（#378）也在这里：前后端各是哪个版本、哪个提交。前端那一份由 app 经 `about` 传进来
 * （platform 不认识 `apps/web` 的 `BRAND`），不传就不显示这一条。
 *
 * 菜单只放这几条。将来页面导览（issue #98 阶段 2）加进来时「本页导览」也放这里，
 * 不要在每个页头上各放一个按钮。
 */
export function HelpMenu({ about }: { about?: AboutInfo }) {
  const { t } = useTranslation()
  const setShortcutsOpen = useCommandStore((s) => s.setShortcutsOpen)
  const [aboutOpen, setAboutOpen] = React.useState(false)

  return (
    <>
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
          // 让菜单先收起、导览再起。同步启动的话 driver 的遮罩会在同一帧盖住正在关闭的菜单
          onClick={() => {
            window.setTimeout(() => startTour(SHELL_TOUR), 0)
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
        {about && (
          <DropdownMenuItem data-testid="help-about" onClick={() => setAboutOpen(true)}>
            <IconInfoCircle className="size-4" />
            {t('关于')}
            {/* 版本号直接印在菜单项上：多数时候人只想瞄一眼是哪一版，不用点进去 */}
            <DropdownMenuShortcut>{about.version}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {about && <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} about={about} />}
    </>
  )
}
