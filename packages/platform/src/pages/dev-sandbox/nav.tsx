import * as React from 'react'
import { IconChevronRight, IconSearch } from '@tabler/icons-react'

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@admin/ui/components/input-group'
import { cn } from '@admin/ui/lib/utils'

import { GROUPS, TIERS, type Demo, type TierId } from './kit'

/**
 * 左栏目录。两级：**层级**（基础 / 复杂 / 令牌）在上，分组在下。
 *
 * 为什么要分层见 `kit.ts` 的 `TIERS` —— 一句话：下家翻目录时第一个问题是
 * 「哪些能直接用、哪些得先搞懂」，平铺的分组不回答这个。
 *
 * ## 🔴 骨架：搜索钉住，**只有列表滚**
 *
 * 原来整栏是 `sticky top-2 self-start`、**没有高度上限** —— 49 个条目比视口还高，
 * 于是 sticky 完全不起作用（一个比视口高的元素没有可粘的余量），
 * 表现是「想看复杂组件得把整页往下拖，拖的时候右边的舞台和代码一起滚走了」。
 * 用户原话：分组菜单看着很费劲。
 *
 * 修法照 `_shared/master-list.tsx` 那套（主从页左栏同一个形状）：
 *
 * ```
 * 搜索框                    shrink-0，钉住
 * ─────────────
 * 层级 / 分组 / 条目          min-h-0 + flex-1 + overflow-y-auto ← 只有这里滚
 * ```
 *
 * 高度上限给在**外层**（`index.tsx` 传进来的 className 里），因为它要按
 * 断点分叉：窄屏是堆叠布局、限高 60svh；`lg` 起才是左栏、减掉外壳的
 * 顶栏（3rem）+ 标签条（约 2.5rem）+ 呼吸。
 *
 * ## 层级可折叠
 *
 * 40 个基础组件铺开之后，「复杂组件」在第 41 行 —— 即便能内滚也要滚一屏。
 * 点层级标题可以整段折叠，三层就都在一屏里了。
 *
 * 折叠状态**留组件 state**，不进 URL：它和旋钮值同类，是「看的人当下的姿势」
 * 而不是「这一屏是什么」。塞进 URL 会让分享出去的链接带一串
 * `collapsed=basic,token` 的垃圾参数，而对方并不关心我折了哪一段。
 * `<Activity>` 会在会话内保住它（硬纪律 2 的互补面）。
 *
 * ⚠️ **搜索时忽略折叠状态**，否则「搜到了、但那一段是折的」= 搜不到。
 */
export function SandboxNav({
  demos,
  active,
  query,
  onQuery,
  onSelect,
  className,
}: {
  demos: Demo[]
  active: string
  query: string
  onQuery: (q: string) => void
  onSelect: (id: string) => void
  className?: string
}) {
  const [collapsed, setCollapsed] = React.useState<Set<TierId>>(() => new Set())
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  const activeRef = React.useRef<HTMLButtonElement | null>(null)

  /**
   * 当前项滚进视野。
   *
   * 🔴 直接打开 `?c=tree` 时列表停在最顶上，而 Tree 在第 41 行 ——
   * 「我在哪」完全看不出来，等于左栏白给。链接分享出去的场景就是这个。
   *
   * ⚠️ **不用 `el.scrollIntoView()`**：它会连**外层**能滚的祖先一起滚
   * （内容区 / 整页），于是右边的舞台跟着跳一下。这里只动自己那一个滚动容器。
   *
   * ⚠️ 也**不用 `document.querySelector`**（硬纪律 5：隐藏 tab 的 DOM 也在
   * 文档树里，会命中别的 tab 的同名节点）—— ref 天然限定在本组件内。
   */
  React.useEffect(() => {
    const box = scrollerRef.current
    const el = activeRef.current
    if (!box || !el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = top - box.clientHeight / 2 + el.offsetHeight / 2
    }
  }, [active])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const hit = (d: Demo) =>
    !q ||
    d.name.toLowerCase().includes(q) ||
    d.zh.includes(q) ||
    d.id.includes(q) ||
    d.summary.toLowerCase().includes(q) ||
    d.use.toLowerCase().includes(q)

  const matched = demos.filter(hit)

  const toggleTier = (id: TierId) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)} data-testid="sandbox-nav">
      <InputGroup className="h-8 shrink-0">
        <InputGroupAddon align="inline-start">
          <IconSearch />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="搜组件"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          data-testid="sandbox-search"
        />
      </InputGroup>

      {/*
        唯一会滚的一层。
        `-me-2 pe-2`：滚动条画在内容右侧的留白里，不然它会压着条目文字。
        `overflow-x-hidden` 不能省 —— 一轴非 visible 时另一轴的 visible 会算成
        auto，只写 overflow-y 会白得一条横向滚动条。
      */}
      <div
        ref={scrollerRef}
        className="-me-2 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pe-2"
      >
        {matched.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            没有匹配「{query}」的组件。
          </p>
        ) : (
          TIERS.map((tier) => {
            const groups = GROUPS.filter((g) => g.tier === tier.id)
            const items = matched.filter((d) => groups.some((g) => g.id === d.group))
            if (!items.length) return null
            const open = searching || !collapsed.has(tier.id)

            return (
              <section key={tier.id} className="flex flex-col">
                {/*
                  层级标题。`sticky top-0` 在滚动区内 —— 滚到哪一段，
                  段名一直在顶上，不用往回翻。背景必须是实色，
                  半透明会让下面的条目从它后面透出来。
                */}
                <button
                  type="button"
                  onClick={() => toggleTier(tier.id)}
                  aria-expanded={open}
                  title={tier.hint}
                  data-testid={`sandbox-tier-${tier.id}`}
                  className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 border-b border-border bg-background px-1 py-1.5 text-start transition-colors hover:bg-muted/60"
                >
                  <IconChevronRight
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground transition-transform',
                      open && 'rotate-90'
                    )}
                  />
                  <span className="text-2xs font-semibold tracking-[0.14em] text-foreground/80 uppercase">
                    {tier.label}
                  </span>
                  <span className="ms-auto font-mono text-2xs tabular-nums text-muted-foreground/60">
                    {items.length}
                  </span>
                </button>

                {open &&
                  groups.map((group) => {
                    const rows = matched.filter((d) => d.group === group.id)
                    if (!rows.length) return null
                    return (
                      <div key={group.id} className="flex flex-col pb-1">
                        <span className="px-2 pt-2.5 pb-1 text-2xs text-muted-foreground/70">
                          {group.label}
                        </span>
                        {rows.map((d) => {
                          const on = d.id === active
                          return (
                            <button
                              key={d.id}
                              ref={on ? activeRef : undefined}
                              type="button"
                              data-testid={`sandbox-item-${d.id}`}
                              data-active={String(on)}
                              onClick={() => onSelect(d.id)}
                              className={cn(
                                // 选中态靠左侧那道 2px 强调条，不只靠底色 ——
                                // 底色在浅色主题下和 hover 太接近，扫一眼分不出来
                                'flex items-baseline gap-2 rounded-md border-s-2 py-1.5 pe-2 ps-2 text-start transition-colors',
                                on
                                  ? 'border-s-primary bg-muted font-medium text-foreground'
                                  : 'border-s-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                              )}
                            >
                              <span className="truncate text-sm">{d.name}</span>
                              <span className="truncate text-2xs text-muted-foreground/70">
                                {d.zh}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}
