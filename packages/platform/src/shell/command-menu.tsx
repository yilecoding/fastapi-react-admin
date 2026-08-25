import * as React from 'react'
import { menuKey } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import {
  IconExternalLink, IconKeyboard, IconPin, IconRefresh, IconSearch, IconX,
} from '@tabler/icons-react'

import { CommandPalette, type CommandItem } from '@admin/ui/components/command-palette'
import { Kbd, KbdGroup } from '@admin/ui/components/kbd'

import { useCommandStore } from './command-store'
import { isEditableTarget, MOD_LABEL } from './hotkeys'
import { MenuIcon } from './icon-registry'
import { ShortcutsDialog } from './shortcuts-dialog'
import { isRemovable, useTabStore } from './tab-store'
import { useSidebar, type NavNode, type SidebarOptions } from './use-sidebar'
import { tabCapabilities, useTabActions } from './use-tab-actions'

/**
 * 命令面板的**业务组装**（展示层在 `ui/components/command-palette.tsx`）。
 *
 * 为什么这个项目特别需要它：卖点是多页签保活，用户被鼓励长时间开一堆 tab，
 * 而菜单树已经十几个模块、三层深 —— 「想去某个功能但记不清在哪个菜单层级」
 * 是这套外壳的高频问题，不是锦上添花。
 *
 * 三组条目，数据源全是**现成的**，不新增任何接口：
 *   已打开的标签页  `tab-store`（和标签条 / 总览下拉同一份）
 *   页面            `use-sidebar` 的导航树（后端下发的侧边栏，同一个 query 缓存）
 *   操作            `use-tab-actions`（和右键菜单同一套动作）
 *
 * ⚠️ 不做「搜业务数据」（搜用户名直接跳详情）—— 那要后端搜索接口，是另一个量级。
 */
export function CommandMenu({ options }: { options: SidebarOptions }) {
  const { t } = useTranslation()
  const open = useCommandStore((s) => s.open)
  const setOpen = useCommandStore((s) => s.setOpen)
  const toggle = useCommandStore((s) => s.toggle)
  const setShortcutsOpen = useCommandStore((s) => s.setShortcutsOpen)

  const navigate = useNavigate()
  const { nav } = useSidebar(options)
  const tabs = useTabStore((s) => s.tabs)
  const activeKey = useTabStore((s) => s.activeKey)
  const act = useTabActions()

  // ── 全局快捷键 ──
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        // 浏览器自己占用了 ⌘K（Firefox 的搜索栏聚焦），必须 preventDefault
        e.preventDefault()
        toggle()
        return
      }
      // `?` 是单键快捷键 —— 输入框里打问号不能弹面板（见 hotkeys.ts）
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault()
        setShortcutsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle, setShortcutsOpen])

  // path → 图标，和标签条用的是同一份映射（同一个 query 缓存，不多打请求）
  const iconByPath = React.useMemo(() => {
    const map = new Map<string, string | null>()
    const walk = (nodes: NavNode[]) => {
      for (const n of nodes) {
        if (n.path) map.set(n.path, n.icon)
        walk(n.children)
      }
    }
    walk(nav)
    return map
  }, [nav])

  /** 标签页组。放最前面：要找的东西开着的概率最高 */
  const tabItems = React.useMemo<CommandItem[]>(
    () =>
      tabs.map((tab) => {
        const pathname = tab.href.split('?')[0] ?? tab.href
        // 与 tab-item / tab-list-menu 同口径：key 用 pathname，回落标题本身即 key
        const label = t(menuKey(pathname), { defaultValue: t(tab.title) })
        return {
          id: `tab:${tab.key}`,
          group: t('已打开的标签页'),
          label,
          hint: tab.href,
          keywords: pathname,
          icon: <MenuIcon name={iconByPath.get(pathname) ?? null} className="size-4" />,
          trailing: (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {tab.pinned && <IconPin className="size-3" />}
              {tab.key === activeKey && t('当前')}
            </span>
          ),
          onSelect: () => act.activate(tab),
        }
      }),
    [tabs, activeKey, act, iconByPath, t]
  )

  /** 页面组：导航树拍平成叶子，`hint` 是它的菜单层级链 */
  const pageItems = React.useMemo<CommandItem[]>(() => {
    // 已经开着的页面在上一组里出现过了，这里不再重复一行 ——
    // 两行点下去行为完全一样，重复只会让列表变长
    const openPaths = new Set(tabs.map((tb) => tb.href.split('?')[0] ?? tb.href))
    const out: CommandItem[] = []
    const walk = (nodes: NavNode[], trail: string[]) => {
      for (const n of nodes) {
        const label = t(menuKey(n.path), { defaultValue: t(n.title) })
        if (n.children.length) {
          // 目录本身不可跳转（它的 path 可能是空串），只贡献层级链
          walk(n.children, [...trail, label])
          continue
        }
        if (n.external) {
          out.push({
            id: `link:${n.id}`,
            group: t('页面'),
            label,
            hint: n.external,
            keywords: n.external,
            icon: <IconExternalLink className="size-4" />,
            onSelect: () => window.open(n.external as string, '_blank', 'noopener,noreferrer'),
          })
          continue
        }
        if (!n.path || openPaths.has(n.path)) continue
        out.push({
          id: `page:${n.id}`,
          group: t('页面'),
          label,
          hint: [...trail, n.path].join(' · '),
          keywords: n.path,
          icon: <MenuIcon name={n.icon} className="size-4" />,
          onSelect: () => void navigate({ to: n.path as never }),
        })
      }
    }
    walk(nav, [])
    return out
  }, [nav, tabs, navigate, t])

  /** 操作组：和标签页右键菜单同一套动作，不可用的直接不列（灰着的条目在搜索列表里没意义） */
  const actionItems = React.useMemo<CommandItem[]>(() => {
    const cap = activeKey ? tabCapabilities(tabs, activeKey) : null
    const out: CommandItem[] = []
    if (activeKey) {
      out.push({
        id: 'action:reload',
        group: t('操作'),
        label: t('重新加载当前页'),
        keywords: 'reload refresh',
        icon: <IconRefresh className="size-4" />,
        onSelect: () => act.reload(activeKey),
      })
    }
    if (cap?.canCloseOthers) {
      out.push({
        id: 'action:close-others',
        group: t('操作'),
        label: t('关闭其它标签页'),
        keywords: 'close others',
        icon: <IconX className="size-4" />,
        onSelect: () => act.closeOthers(activeKey as string),
      })
    }
    if (tabs.some(isRemovable)) {
      out.push({
        id: 'action:close-all',
        group: t('操作'),
        label: t('关闭全部标签页'),
        keywords: 'close all',
        icon: <IconX className="size-4" />,
        onSelect: () => act.closeAll(),
      })
    }
    out.push({
      id: 'action:shortcuts',
      group: t('操作'),
      label: t('快捷键'),
      hint: t('按 ? 随时打开这一屏。'),
      keywords: 'shortcuts keyboard help',
      icon: <IconKeyboard className="size-4" />,
      onSelect: () => setShortcutsOpen(true),
    })
    return out
  }, [tabs, activeKey, act, setShortcutsOpen, t])

  const items = React.useMemo(
    () => [...tabItems, ...pageItems, ...actionItems],
    [tabItems, pageItems, actionItems]
  )

  return (
    <>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        items={items}
        title={t('命令面板')}
        placeholder={t('搜索页面、标签页与操作…')}
        emptyText={t('没有匹配的结果')}
        footer={
          <>
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="ms-1">{t('移动')}</span>
              <Kbd className="ms-2">Enter</Kbd>
              <span className="ms-1">{t('打开')}</span>
              <Kbd className="ms-2">Esc</Kbd>
              <span className="ms-1">{t('关闭')}</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>?</Kbd>
              <span className="ms-1">{t('快捷键')}</span>
            </KbdGroup>
          </>
        }
      />
      <ShortcutsDialog />
    </>
  )
}

/**
 * 顶栏里的入口。
 *
 * 🔴 光有 ⌘K 不够 —— **没被看见的快捷键等于不存在**，⌘B 折叠侧边栏在这个仓库里
 * 存在很久，界面上从来没有任何地方写过它，结果只有作者知道。所以这里摆一个
 * 长得像搜索框的按钮，右边把 `⌘K` 印上去（`Kbd` 组件的第一个真实调用方）。
 * 窄屏收成一个图标按钮。
 */
export function CommandTrigger() {
  const { t } = useTranslation()
  const setOpen = useCommandStore((s) => s.setOpen)
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      data-testid="command-trigger"
      aria-label={t('打开命令面板')}
      className="flex h-8 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-sm text-muted-foreground transition-colors hover:bg-muted sm:w-56"
    >
      <IconSearch className="size-4 shrink-0" />
      <span className="hidden flex-1 truncate text-start sm:inline">{t('搜索页面…')}</span>
      <KbdGroup className="hidden sm:inline-flex">
        <Kbd>{MOD_LABEL}</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
    </button>
  )
}
