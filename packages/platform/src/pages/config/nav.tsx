import type * as React from 'react'
import {
  IconAdjustments, IconCircleFilled, IconCode, IconLogin, IconMail,
  IconPlugConnectedX, IconShieldLock, IconSparkles,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@admin/ui/lib/utils'

import { RAIL, railItem } from './registry'

/**
 * 左栏图标，按 `RailItem.id`（= `sys_config.type`）查。
 *
 * 不放进 `registry.ts` 的 `RailItem` 类型里 —— 那份注册表刻意保持纯数据
 * （不 import React），图标这种渲染层的东西留在这个文件里查表，和
 * `_shared/settings-shell.tsx` 的 `SettingsPanel.icon` 是同一个分工。
 * 兜底给 `IconAdjustments`：新增分类忘了配图标，也不会漏成一个空位。
 */
const RAIL_ICONS: Record<string, React.ReactNode> = {
  LOGIN: <IconLogin />,
  USER_SECURITY: <IconShieldLock />,
  EMAIL: <IconMail />,
  AI: <IconSparkles />,
  DEV: <IconCode />,
  other: <IconAdjustments />,
}
export const railIcon = (id: string): React.ReactNode => RAIL_ICONS[id] ?? <IconAdjustments />

/**
 * 左栏。分类归属和文案来自 `registry.ts: RAIL`，**不是**从 `sys_config.type`
 * 直接生成 —— 那样只会得到四个平铺的英文枚举值。
 *
 * 每项带三个状态：条数、有未保存改动（琥珀点）、整组被总开关关掉（插头图标）。
 * 后两个是这一页最容易被忽略的信息 —— 改了别组忘了存、或者改了一整组
 * 但那组的总开关是关的（后端整组不加载，改了等于没改）。
 *
 * 选中态和图标照 `_shared/settings-shell.tsx` 的口径：主色淡底 + 主色文字
 * （不是灰底 —— 灰底选中项和 hover 态几乎分不出来），纯文字竖导航配图标
 * 让「登录策略」「邮件服务」这些项在余光里就能认出来。
 */
export function ConfigNav({
  active,
  counts,
  dirtyIds,
  disabledIds,
  onSelect,
}: {
  active: string
  counts: Record<string, number>
  /** 有未保存改动的分组 id */
  dirtyIds: Set<string>
  /** 总开关为 0 的分组 id */
  disabledIds: Set<string>
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <nav className="flex flex-col gap-5" data-testid="config-nav">
      {RAIL.map((group) => {
        // 一条数据都没有的分组不占位置（如种子里没有 AI）
        const items = group.items.filter((i) => (counts[i.id] ?? 0) > 0)
        if (!items.length) return null
        return (
          <div key={group.title} className="flex flex-col gap-1">
            <span className="px-3 text-xs font-medium tracking-wide text-muted-foreground">
              {t(group.title)}
            </span>
            {items.map((i) => {
              const on = i.id === active
              return (
                <button
                  key={i.id}
                  type="button"
                  data-testid={`nav-cfg-${i.id}`}
                  data-active={String(on)}
                  onClick={() => onSelect(i.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-start text-sm transition-colors',
                    on
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                >
                  <span className="shrink-0 [&>svg]:size-4">{railIcon(i.id)}</span>
                  <span className="min-w-0 flex-1 truncate">{t(i.label)}</span>
                  {disabledIds.has(i.id) && (
                    <IconPlugConnectedX
                      className="size-3.5 shrink-0 text-muted-foreground"
                      title={t("该组总开关已关闭，配置不生效")}
                    />
                  )}
                  {dirtyIds.has(i.id) && (
                    <IconCircleFilled
                      className="size-2 shrink-0 text-amber-500"
                      data-testid={`nav-dirty-${i.id}`}
                      title={t("有未保存的改动")}
                    />
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {counts[i.id]}
                  </span>
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}

export const navDesc = (id: string) => railItem(id)?.desc
