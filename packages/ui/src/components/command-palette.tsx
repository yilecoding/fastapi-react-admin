"use client"

/**
 * command-palette.tsx
 *
 * 命令面板的**展示层**：一个输入框 + 分组列表 + 键盘导航。零业务 ——
 * 条目（`items`）由调用方喂，选中做什么也由调用方在 `onSelect` 里决定。
 * 业务侧的组装在 `platform/shell/command-menu.tsx`。
 *
 * 为什么手写而不是引 cmdk：`command.tsx`（cmdk 封装）在这个仓库里零调用方，
 * 已经连着 cmdk/radix 依赖链一起删掉了（见 `packages/ui/AGENTS.md`）。
 * 这里要的东西很薄 —— Dialog（已有，Base UI 底座）+ 一个受控列表 +
 * 一个匹配函数，不值得把那条依赖链重新拉回来。
 *
 * ⚠️ 也**不用** `Combobox`（同样是 Base UI 底座）：它是「触发器 + 浮层」的
 * 选值控件，浮层自己管定位与开合。这里要的是「对话框内整块列表 +
 * 输入框常驻聚焦」，套进 Dialog 会变成两层焦点管理互相抢。
 */
import * as React from "react"
import { IconCornerDownLeft, IconSearch } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import { Dialog, DialogContent, DialogTitle } from "@admin/ui/components/dialog"
import { Kbd } from "@admin/ui/components/kbd"
import { cn } from "@admin/ui/lib/utils"

export type CommandItem = {
  /** 稳定唯一，同时用于 `data-testid` */
  id: string
  label: string
  /** 第二行的弱化说明（菜单层级链 / 路由地址） */
  hint?: string
  icon?: React.ReactNode
  /** 分组标题。同一组的条目按传入顺序聚在一起 */
  group: string
  /** 参与匹配但不显示（路由 path、别名） */
  keywords?: string
  /** 行尾的小徽标（「已打开」这类） */
  trailing?: React.ReactNode
  onSelect: () => void
}

/**
 * 子序列匹配 + 打分。返回 `null` = 不匹配。
 *
 * 规则按「用户敲的是缩写」来定：`sjqx` 要能命中「数据权限」的路由
 * `/system/data-permission`（连续段更高分），而 `限权` 不该命中「权限」——
 * 所以是**顺序**子序列，不是「包含全部字符」。
 */
export function commandScore(query: string, item: CommandItem): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const haystacks: Array<[string, number]> = [
    [item.label.toLowerCase(), 3],
    [(item.keywords ?? "").toLowerCase(), 2],
    [(item.hint ?? "").toLowerCase(), 1],
  ]
  let best: number | null = null
  for (const [text, weight] of haystacks) {
    if (!text) continue
    const s = subsequenceScore(q, text)
    if (s === null) continue
    const score = s * weight
    if (best === null || score > best) best = score
  }
  return best
}

function subsequenceScore(q: string, text: string): number | null {
  // 整段命中最高分，且越靠前越好（前缀 > 词首 > 中间）
  const idx = text.indexOf(q)
  if (idx === 0) return 1000
  if (idx > 0) return 700 - Math.min(idx, 60)

  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = text.indexOf(ch, ti)
    if (found === -1) return null
    // 紧邻上一个命中就加成，连续段越长分越高
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(found - ti, 10)
    ti = found + 1
  }
  return score
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder,
  emptyText,
  footer,
  title,
  testId = "command-palette",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: readonly CommandItem[]
  placeholder?: string
  emptyText?: string
  /** 底部提示条（快捷键说明这类） */
  footer?: React.ReactNode
  /** 无障碍标题，视觉上隐藏 */
  title?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  /**
   * 每次打开都从空查询、第一条开始 —— 上一次的搜索词留着会让人以为「搜不到东西」。
   *
   * ⚠️ 这里刻意**不用 effect**（`useEffect(() => setQuery(''), [open])`）：
   * 那是 react.dev「你可能不需要 effect」里点名的级联渲染，`eslint-plugin-react-hooks`
   * 的 `set-state-in-effect` 也会直接报错。用官方那条「prop 变了就在渲染期调整 state」
   * 的写法：本次渲染立刻带上新值，不会先渲染一帧旧的再纠正。
   */
  const [prevOpen, setPrevOpen] = React.useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setQuery("")
      setActiveIndex(0)
    }
  }

  /** 过滤 + 排序（分数降序，同分保持传入顺序），再按 group 归拢 */
  const matched = React.useMemo(() => {
    const scored: Array<{ item: CommandItem; score: number; order: number }> = []
    items.forEach((item, order) => {
      const score = commandScore(query, item)
      if (score === null) return
      scored.push({ item, score, order })
    })
    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order))
    return scored.map((s) => s.item)
  }, [items, query])

  const groups = React.useMemo(() => {
    const out: Array<{ group: string; items: CommandItem[] }> = []
    for (const item of matched) {
      const last = out[out.length - 1]
      if (last && last.group === item.group) last.items.push(item)
      else out.push({ group: item.group, items: [item] })
    }
    return out
  }, [matched])

  const clamped = matched.length ? Math.min(activeIndex, matched.length - 1) : 0
  const active = matched[clamped]

  // 高亮项滚进可见区。**范围限定在 listRef 内** —— 全局 querySelector 会
  // 命中隐藏 tab 里的同名元素（见根 CLAUDE.md 硬纪律 5）
  React.useEffect(() => {
    if (!open || !active) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-command-id="${CSS.escape(active.id)}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [open, active])

  const move = (delta: number) => {
    if (!matched.length) return
    setActiveIndex((i) => {
      const next = Math.min(i, matched.length - 1) + delta
      // 循环：到底再按一下回到顶，比「按不动了」少一次困惑
      return (next + matched.length) % matched.length
    })
  }

  const run = (item: CommandItem | undefined) => {
    if (!item) return
    // 先关面板再执行 —— 反过来的话导航把新页面挂上了，面板还盖在上面一帧
    onOpenChange(false)
    item.onSelect()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      move(1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      move(-1)
    } else if (e.key === "Home") {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      setActiveIndex(matched.length - 1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      run(active)
    }
  }

  let index = -1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // 命令面板要贴上方：列表会长到 60vh，居中的话每次打开视线都要往下找
        className="top-[12vh] max-h-[76vh] w-full max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid={testId}
      >
        <DialogTitle className="sr-only">{title ?? t("命令面板")}</DialogTitle>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <IconSearch className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // 高亮跟着回到第一条 —— 不回的话「敲完第二个字回车打开的是上一次那条」。
              // 放在事件里而不是 effect 里，同上面那条注释
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? t("搜索页面、标签页与操作…")}
            data-testid={`${testId}-input`}
            aria-controls={`${testId}-list`}
            aria-activedescendant={active ? `${testId}-item-${active.id}` : undefined}
            role="combobox"
            aria-expanded
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div
          ref={listRef}
          id={`${testId}-list`}
          role="listbox"
          aria-label={title ?? t("命令面板")}
          className="max-h-[60vh] overflow-y-auto overflow-x-hidden p-1"
        >
          {!matched.length && (
            <p
              className="px-3 py-8 text-center text-sm text-muted-foreground"
              data-testid={`${testId}-empty`}
            >
              {emptyText ?? t("没有匹配的结果")}
            </p>
          )}

          {groups.map((g) => (
            <div key={`${g.group}-${g.items[0]?.id}`} className="mb-1 last:mb-0">
              <div className="px-2 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {g.group}
              </div>
              {g.items.map((item) => {
                index += 1
                const isActive = index === clamped
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    id={`${testId}-item-${item.id}`}
                    aria-selected={isActive}
                    data-command-id={item.id}
                    data-active={isActive || undefined}
                    data-testid={`${testId}-item-${item.id}`}
                    // hover 也要同步高亮，否则鼠标停在 A 上、回车打开的是 B
                    onMouseMove={() => setActiveIndex(matched.indexOf(item))}
                    onClick={() => run(item)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors",
                      isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
                    )}
                  >
                    {item.icon && <span className="shrink-0 text-muted-foreground">{item.icon}</span>}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{item.label}</span>
                      {item.hint && (
                        <span className="truncate text-xs text-muted-foreground">{item.hint}</span>
                      )}
                    </span>
                    {item.trailing}
                    {isActive && (
                      <Kbd className="shrink-0">
                        <IconCornerDownLeft />
                      </Kbd>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {footer && (
          <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
