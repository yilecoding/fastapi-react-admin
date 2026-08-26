import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { isRemovable, useTabStore, type Tab } from './tab-store'

/**
 * 标签条的动作层。
 *
 * 抽出来的理由：右键菜单、右侧工具区、中键关闭三处要用同一套动作，
 * 而每个动作都是「改 store + 决定跳到哪个 tab」两步 ——
 * 少跳一次就会出现「tab 关了但页面还停在那儿」。
 */
export function useTabActions() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const go = React.useCallback((href: string) => void navigate({ to: href }), [navigate])

  /** 按 key 跳转；key 为 null（关到一个不剩）时回仪表盘 */
  const goKey = React.useCallback(
    (key: string | null) => {
      if (!key) return go('/dashboard')
      const t = useTabStore.getState().tabs.find((x) => x.key === key)
      if (t) go(t.href)
    },
    [go]
  )

  return React.useMemo(() => {
    const s = () => useTabStore.getState()
    return {
      activate: (tab: Tab) => go(tab.href),
      close: (key: string) => goKey(s().close(key)),
      closeOthers: (key: string) => {
        s().closeOthers(key)
        goKey(key)
      },
      closeLeft: (key: string) => {
        s().closeLeft(key)
        goKey(key)
      },
      closeRight: (key: string) => {
        s().closeRight(key)
        goKey(key)
      },
      closeAll: () => goKey(s().closeAll()),
      togglePin: (key: string) => s().togglePin(key),
      /**
       * 重新加载：revision +1，TabOutlet 靠它换 key 重挂页面。
       *
       * 🔴 **必须同时把缓存作废**，光重挂是不够的：全局 `staleTime: 30_000`
       * 让 react-query 认为数据还新鲜，`refetchOnMount` 于是不发请求 ——
       * 实测「重新加载当前页」在 30 秒内是**空操作**（0 次请求），30 秒后才
       * 真的重取。一个动作的行为取决于「你上次看它是几秒前」，是最反直觉的
       * 那种坏（issue #36）。
       *
       * `refetchType: 'active'` —— 只有当前可见页面的 query 立刻重取；隐藏 tab
       * 的 query 没有观察者（`<Activity>` 销毁了 effects），只标记为过期，
       * 等它被切回来时再取。刻意不改全局 `staleTime`：30 秒是为了「多页签切来
       * 切去不打后端」，那个理由仍然成立。
       */
      reload: (key: string) => {
        void qc.invalidateQueries({ refetchType: 'active' })
        s().reload(key)
      },
      openInNewWindow: (tab: Tab) => window.open(tab.href, '_blank', 'noopener,noreferrer'),
    }
  }, [go, goKey])
}

export type TabCapabilities = {
  canClose: boolean
  canCloseLeft: boolean
  canCloseRight: boolean
  canCloseOthers: boolean
  canCloseAll: boolean
  /** 路由声明的常驻页（仪表盘）不给动固定态 —— 它本来就关不掉 */
  canPin: boolean
  pinned: boolean
}

/** 菜单项的可用性 —— 灰掉比点了没反应好 */
export function tabCapabilities(tabs: Tab[], key: string): TabCapabilities {
  const idx = tabs.findIndex((t) => t.key === key)
  const target = idx >= 0 ? tabs[idx] : undefined
  return {
    canClose: Boolean(target && isRemovable(target)),
    canCloseLeft: tabs.slice(0, Math.max(idx, 0)).some(isRemovable),
    canCloseRight: idx >= 0 && tabs.slice(idx + 1).some(isRemovable),
    canCloseOthers: tabs.some((t, i) => i !== idx && isRemovable(t)),
    canCloseAll: tabs.some(isRemovable),
    canPin: Boolean(target?.closable),
    pinned: Boolean(target?.pinned),
  }
}
