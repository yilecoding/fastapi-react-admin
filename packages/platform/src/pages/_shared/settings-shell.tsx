import * as React from 'react'
import { Activity } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@admin/ui/lib/utils'

/**
 * 设置类页面的骨架：左侧一条竖导航 + 右侧**切换**面板。
 *
 * 与被它取代的 `settings-layout.tsx`（左侧锚点 + 右侧长滚动）的区别，
 * 以及为什么换掉：
 *
 * 1. **一层导航。** 原来个人中心是「顶部页签 + 页签内左栏」两层导航管 8 个小节。
 *    GitHub / Linear / Zapier 的账号设置都是一条竖导航到底。
 * 2. **当前面板进得了 URL。** 锚点式的「当前小节」是滚动位置的副产品，
 *    每滚一下改一次 URL 是不可接受的，于是它只能留在组件 state 里 ——
 *    刷新就丢，违反「视图状态必须进 URL」。切换式的 `value` 就是一个普通受控值。
 * 3. **不需要自己造滚动容器。** 锚点式必须让右栏自己滚（`IntersectionObserver`
 *    的 root 要指向它），而右栏高度又只能写成 `calc(100dvh-14rem)` ——
 *    这个 14rem 和顶栏 + 标签条的高度硬耦合，关掉多标签页时底部就多出一截空白。
 *    切换式让页面按自然高度滚，那条耦合整根拿掉。
 *
 * ⚠️ **组件 router-独立**：`value` / `onChange` 只走 props（见 CLAUDE.md 硬纪律 1）。
 *
 * ## 内容区**刻意不封顶**（这是一个权衡，不是漏了）
 *
 * 内容区左右铺满可用宽度，`SettingRow` 的文字列撑满、控件顶到最右边。
 *
 * 代价是实打实的：1600px 视口下开关行「标签文字 → 开关」实测 926~954px，
 * 1920px 下超过 1200px —— 一个 44px 的开关孤零零钉在那头，眼睛得跨过大半屏
 * 才能把「显示标签页图标」和它配上对。
 *
 * 曾经封顶过 40rem，把这个距离压到 448~476px（Primer 把 GitHub 整页封在 1280px
 * 就是同一个理由：一行别塞太多东西）。但封顶之后 1920px 视口右侧空出 808px、
 * 2560px 空出 1448px，看起来像「右边没排满」。**两害取其轻是产品选择，选了铺满。**
 *
 * 要改回封顶只是一行：把 `CONTENT_MAX` 加回 `max-w-[40rem]` 并套回 header 与面板。
 */
export type SettingsPanel = {
  id: string
  label: string
  /** 左栏分组名，相邻同名的会并成一组 */
  group: string
  content: React.ReactNode
  /**
   * 左栏图标。**必给** —— 一条纯文字的竖导航要靠读字来定位，
   * 图标让「安全」「主题」这些项在余光里就能认出来。
   */
  icon?: React.ReactNode
  /** 左栏项右侧的小标记（如未保存草稿的圆点） */
  mark?: React.ReactNode
}

export function SettingsShell({
  panels,
  value,
  onChange,
  header,
  testId,
}: {
  panels: SettingsPanel[]
  value: string
  onChange: (id: string) => void
  /** 身份区之类的通栏内容，钉在内容列上方 */
  header?: React.ReactNode
  testId?: string
}) {
  const { t } = useTranslation()

  // 传进来的 id 可能来自 URL（用户手改、或是老链接），兜底回第一个面板
  const active = panels.find((p) => p.id === value) ?? panels[0]

  const groups = React.useMemo(() => {
    const out: Array<{ group: string; items: SettingsPanel[] }> = []
    for (const p of panels) {
      const last = out[out.length - 1]
      if (last && last.group === p.group) last.items.push(p)
      else out.push({ group: p.group, items: [p] })
    }
    return out
  }, [panels])

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start" data-testid={testId}>
      {/* ── 左：竖导航 ── */}
      <nav
        className="flex w-full shrink-0 flex-col gap-4 md:sticky md:top-2 md:w-44"
        aria-label={t('设置分组')}
      >
        {groups.map(({ group, items }) => (
          <div key={group} className="flex flex-col gap-0.5">
            <span className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group}</span>
            {items.map((p) => {
              const on = active?.id === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`settings-nav-${p.id}`}
                  aria-current={on || undefined}
                  onClick={() => onChange(p.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors',
                    // 选中态用**主色淡底 + 主色文字**而不是灰底：灰底选中项和 hover 态
                    // 几乎分不出来，一条 6 项的导航里得盯着看才知道自己在哪一项
                    on
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                >
                  {p.icon && <span className="shrink-0 [&>svg]:size-4">{p.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  {p.mark}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* ── 右：面板 ──
          `min-w-0` 不能省：这是 flex 项，缺了它内容（长表格、不换行文本）会撑破
          整页并长出横向滚动条（见 CLAUDE.md 里 `min-width:auto` 那条）

          ⚠️ **所有面板同时挂载，用 `<Activity>` 控显隐**，不是「只渲染当前那个」。
          只渲染当前面板的话，切走再切回来，昵称/邮箱/密码那几个输入框里没提交的
          草稿全丢 —— 原来用的是 `<TabsContent keepMounted>`，换外壳不能把这个能力弄丢。
          `<Activity mode="hidden">` 保 state、销毁 effect，所以隐藏面板里的
          `useQuery` 不会在后台轮询（「最近登录」不会因为你在看主题而反复取数）。

          ⚠️ 隐藏面板的 DOM 仍在文档树里（CLAUDE.md 硬纪律 5）。要在测试或脚本里
          锁某个面板，按 **`[data-panel="<id>"]`** 锁，不要用 `[data-active="true"]`
          —— 切换瞬间有一小段窗口两个面板都可能匹配上。 */}
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {header}
        {panels.map((p) => (
          <Activity key={p.id} mode={p.id === active?.id ? 'visible' : 'hidden'}>
            <div
              data-panel={p.id}
              data-active={p.id === active?.id || undefined}
            >
              {/* **不套卡片框。** 页面底色和 `bg-card` 都是近白，一层
                  `ring-1 ring-foreground/10` + `shadow-xs` 在这里只是画了一道
                  没有信息量的边 —— 内容列已经封顶 40rem、左边还有条导航，
                  「这一块到哪里为止」本来就看得出来。
                  块与块的分隔交给 `Block` 自己的 `border-b` 一根细线。 */}
              <div className="flex flex-col gap-6">{p.content}</div>
            </div>
          </Activity>
        ))}
      </div>
    </div>
  )
}
