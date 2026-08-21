import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconArrowBarToLeft, IconArrowBarToRight, IconExternalLink, IconPin, IconPinnedOff,
  IconRefresh, IconX, IconArrowsMinimize, IconTrash,
} from '@tabler/icons-react'

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@admin/ui/components/dropdown-menu'

import { tabCapabilities, useTabActions } from './use-tab-actions'
import { useTabStore, type Tab } from './tab-store'

/**
 * 标签页的右键菜单。
 *
 * 两条实现约束：
 * 1. **不能把 tab 本身做成 `DropdownMenuTrigger`** —— 那样左键会被菜单吃掉，
 *    点 tab 变成开菜单而不是切页。菜单是受控的，由 contextmenu 事件打开。
 * 2. 无 trigger 的受控菜单必须给 `anchor`，且 `anchor` 要落在 Positioner 上
 *    （见 `ui/dropdown-menu.tsx`）。这里锚到鼠标位置，跟系统右键菜单的手感一致。
 */
export type TabMenuTarget = { key: string; x: number; y: number }

export function TabMenu({
  target,
  onClose,
}: {
  target: TabMenuTarget | null
  onClose: () => void
}) {
  const tabs = useTabStore((s) => s.tabs)
  const act = useTabActions()

  // 虚拟锚点：鼠标位置的一个零尺寸矩形
  const anchor = React.useMemo(() => {
    if (!target) return undefined
    const { x, y } = target
    return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }
  }, [target])

  const { t } = useTranslation()
  const tab: Tab | undefined = target ? tabs.find((x) => x.key === target.key) : undefined
  const cap = target ? tabCapabilities(tabs, target.key) : null
  if (!target || !tab || !cap) return null

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuContent align="start" anchor={anchor} className="w-44" data-testid="tab-context-menu">
        <DropdownMenuItem
          disabled={!cap.canClose}
          data-testid="tab-menu-close"
          onClick={run(() => act.close(tab.key))}
        >
          <IconX className="size-4" />{t('关闭')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!cap.canPin}
          data-testid="tab-menu-pin"
          onClick={run(() => act.togglePin(tab.key))}
        >
          {cap.pinned ? <IconPinnedOff className="size-4" /> : <IconPin className="size-4" />}
          {cap.pinned ? t('取消固定') : t('固定')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="tab-menu-reload" onClick={run(() => act.reload(tab.key))}>
          <IconRefresh className="size-4" />{t('重新加载')}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="tab-menu-new-window"
          onClick={run(() => act.openInNewWindow(tab))}
        >
          <IconExternalLink className="size-4" />{t('在新窗口打开')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!cap.canCloseLeft}
          data-testid="tab-menu-close-left"
          onClick={run(() => act.closeLeft(tab.key))}
        >
          <IconArrowBarToLeft className="size-4" />{t('关闭左侧标签页')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!cap.canCloseRight}
          data-testid="tab-menu-close-right"
          onClick={run(() => act.closeRight(tab.key))}
        >
          <IconArrowBarToRight className="size-4" />{t('关闭右侧标签页')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!cap.canCloseOthers}
          data-testid="tab-menu-close-others"
          onClick={run(() => act.closeOthers(tab.key))}
        >
          <IconArrowsMinimize className="size-4" />{t('关闭其它标签页')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!cap.canCloseAll}
          variant="destructive"
          data-testid="tab-menu-close-all"
          onClick={run(() => act.closeAll())}
        >
          <IconTrash className="size-4" />{t('关闭全部标签页')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
