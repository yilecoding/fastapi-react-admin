import { IconPin, IconX } from '@tabler/icons-react'
import { menuKey } from '@admin/i18n'
import { useTranslation } from 'react-i18next'

import { cn } from '@admin/ui/lib/utils'

import { MenuIcon } from './icon-registry'
import type { TabStyle } from './preferences'
import type { Tab } from './tab-store'

/**
 * 单个标签页。
 *
 * 交互对齐若依/Vben 的肌肉记忆：
 *   左键   → 切到该 tab
 *   中键   → 关闭（可在偏好设置里关掉）
 *   右键   → 菜单
 *   ×      → 关闭；固定的 tab 不显示 ×，改显示图钉
 *
 * **外观全部收在下面这张表里**，由 `preferences.tabStyle` 选。
 * 新增一种风格 = 这张表加一行 + `TabStyle` 加一个字面量 + `TAB_STYLE_LABELS` 加个中文名，
 * 标签条与将来的偏好设置页都不用改。
 * （没用 cva：`packages/platform` 没有这个依赖，一张表反而更直观）
 */
const BASE =
  'group flex shrink-0 cursor-pointer items-center gap-1.5 text-sm transition-colors ' +
  // scroll-mx-5：scrollIntoView 尊重 scroll-margin —— 活动 tab 滚进来时离容器边缘留 20px，
  // 不会正好压在两端的渐隐带上
  'scroll-mx-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

const STYLES: Record<TabStyle, { shape: string; active: string; idle: string }> = {
  /** 卡片：白底 + 1px 边框 + 轻阴影（默认） */
  card: {
    shape: 'rounded-md border px-2.5 py-1',
    active: 'border-border bg-background font-medium text-foreground shadow-sm',
    idle: 'border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
  },
  /** 按钮：活动态实心填充，不描边 */
  button: {
    shape: 'rounded-md border border-transparent px-2.5 py-1',
    active: 'bg-primary font-medium text-primary-foreground',
    idle: 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
  },
  /** 柔和：活动态主色淡底，无边框 */
  soft: {
    shape: 'rounded-md border border-transparent px-2.5 py-1',
    active: 'bg-primary/10 font-medium text-primary',
    idle: 'text-muted-foreground hover:bg-primary/5 hover:text-foreground',
  },
  /** 下划线：无圆角无底色，活动态在底部 2px 主色线，整条贴齐标签条底边 */
  underline: {
    shape: 'h-full self-stretch border-b-2 border-transparent px-3',
    active: 'border-primary font-medium text-primary',
    idle: 'text-muted-foreground hover:border-border hover:text-foreground',
  },
}

export function TabItem({
  tab,
  active,
  icon,
  closable,
  styleName = 'card',
  showIcon = true,
  middleClickClose = true,
  draggable = false,
  dragging = false,
  dropSide,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  tab: Tab
  active: boolean
  /** 侧边栏菜单里的图标名，取不到就画默认点 */
  icon?: string | null
  closable: boolean
  styleName?: TabStyle
  showIcon?: boolean
  middleClickClose?: boolean
  draggable?: boolean
  /** 自己正被拖着 */
  dragging?: boolean
  /** 拖到自己身上时，插入线画在哪一侧；不在拖拽中就是 undefined */
  dropSide?: 'start' | 'end'
  onActivate: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: () => void
  onDragOver?: (side: 'start' | 'end') => void
  onDrop?: () => void
  onDragEnd?: () => void
}) {
  const { t } = useTranslation()
  /**
   * tab 标题的翻译 key 用 **pathname**（`href` 去掉 search），
   * 而不是标题本身 —— 标题来自路由 staticData 或后端菜单表，
   * 管理员随时能改，改了译文就失效。查不到时 defaultValue 回落原标题。
   */
  const tabLabel = t(menuKey(tab.href.split('?')[0]), { defaultValue: t(tab.title) })
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      data-active={active || undefined}
      data-style={styleName}
      data-dragging={dragging || undefined}
      data-drop={dropSide}
      // 用 tab.key（= routeId + JSON(params)）不用 routeId：内嵌页路由
      // `/_auth/embedded/$name` 这类带参数的路由，routeId 对不同参数是同一个值，
      // 两个不同的内嵌 tab 会渲染出完全相同的 testid。tab-outlet.tsx 对页面内容
      // 那层用的也是 tabKey（= tab.key），这里要跟它同口径。
      data-testid={`tab-${tab.key}`}
      draggable={draggable}
      onDragStart={(e) => {
        // 必须写点东西进 dataTransfer，否则 Firefox 不认这是一次有效拖拽
        e.dataTransfer.setData('text/plain', tab.key)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.()
      }}
      onDragOver={(e) => {
        if (!onDragOver) return
        // 不 preventDefault 就不会触发 drop
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        onDragOver(e.clientX < r.left + r.width / 2 ? 'start' : 'end')
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop?.()
      }}
      onDragEnd={() => onDragEnd?.()}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
        }
      }}
      // 中键关闭：auxclick 才是标准事件，mousedown 里拦会连带触发页面滚动
      onAuxClick={(e) => {
        if (e.button === 1 && closable && middleClickClose) {
          e.preventDefault()
          onClose()
        }
      }}
      onContextMenu={onContextMenu}
      className={cn(
        BASE,
        STYLES[styleName].shape,
        active ? STYLES[styleName].active : STYLES[styleName].idle,
        dragging && 'opacity-40',
        // 插入位置用一条 2px 主色竖线表示（画在内侧，不占布局，避免整排抖动）
        dropSide === 'start' && 'shadow-[inset_2px_0_0_0_var(--color-primary)]',
        dropSide === 'end' && 'shadow-[inset_-2px_0_0_0_var(--color-primary)]'
      )}
    >
      {showIcon && <MenuIcon name={icon} className="size-3.5 shrink-0" />}
      {/* tab 标题来自路由 staticData 或后端菜单表，都是中文字面量 ——
          「原文即 key」让它直接可翻，路由文件里一个字都不用改
          （路由是模块级定义，压根没法调 hook） */}
      {/* key 用 path 而不是标题：标题存在库里、管理员随时能改，
          改了译文就失效；path 是从前端真实路由下拉选的，最稳。
          查不到就 defaultValue 回落库里的中文标题 —— 不会露 raw key */}
      <span className="max-w-40 truncate whitespace-nowrap">{tabLabel}</span>
      {tab.pinned ? (
        <IconPin className="size-3 shrink-0 opacity-60" aria-label={t("已固定")} />
      ) : closable ? (
        <button
          type="button"
          aria-label={t('关闭 {{name}}', { name: tabLabel })}
          data-testid={`close-${tab.key}`}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className={cn(
            'ms-0.5 rounded-sm p-0.5 opacity-50 transition-opacity hover:opacity-100 group-hover:opacity-80',
            // 实心的按钮风格下，hover 底色要用当前文字色的淡层，不然白底压不出层次
            active && styleName === 'button' ? 'hover:bg-primary-foreground/20' : 'hover:bg-muted'
          )}
        >
          <IconX className="size-3" />
        </button>
      ) : (
        // 占位，避免常驻页与可关闭页的宽度跳动
        <span className="ms-0.5 size-4 shrink-0" />
      )}
    </div>
  )
}
