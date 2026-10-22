/**
 * 登录页左栏：品牌面板。
 *
 * 主角是 `TenonStage` 那枚立体榫卯 —— 品牌标记本身，而不是一张讲架构的示意图。
 * 原来这里画的是「用户 → 角色 → 菜单 / 数据范围」授权链路：那是给读 README 的开发者看的，
 * 每天来登录的人不需要被教育 RBAC，而且整页唯一的饱和色只剩登录按钮（#124）。
 *
 * 它**跟随主题**：浅色下是一块淡紫渐变面，深色下是近黑偏紫。一整套色走 `.tenon-panel`
 * 上的自定义属性，深色分支交给 `.dark .tenon-panel` —— 纯 CSS 切换，不把主题状态读进 React。
 *
 * 文件名带 `-` 前缀，TanStack Router 的文件路由会跳过它（同 routes/-404.tsx）。
 */
import * as React from "react"
import { Trans, useTranslation } from "react-i18next"

import { TenonBadge } from "@/components/tenon-mark"
import { BRAND } from "@/lib/brand"
import { TenonStage } from "@/routes/_guest/-tenon-stage"

const CSS = `
.tenon-panel {
  --tenon-bg: linear-gradient(165deg, oklch(0.982 0.008 285) 0%, oklch(0.955 0.02 277) 48%, oklch(0.982 0.012 320) 100%);
  --tenon-glow: oklch(0.457 0.24 277 / 0.2);
  --tenon-glow-2: oklch(0.65 0.22 350 / 0.12);
  --tenon-ring: oklch(0.145 0 0 / 0.06);
  --tenon-ink: oklch(0.145 0 0);
  --tenon-dim: oklch(0.44 0.02 277);
  --tenon-accent: oklch(0.457 0.24 277);
  --tenon-shine-mid: oklch(0.62 0.19 283);
  --tenon-shine-hot: oklch(0.65 0.23 350);
  --tenon-chip-bg: oklch(1 0 0 / 0.72);
  --tenon-chip-line: oklch(0.457 0.24 277 / 0.2);
}
.dark .tenon-panel {
  --tenon-bg: linear-gradient(165deg, oklch(0.205 0.045 282) 0%, oklch(0.16 0.03 277) 50%, oklch(0.175 0.04 305) 100%);
  --tenon-glow: oklch(0.55 0.24 277 / 0.32);
  --tenon-glow-2: oklch(0.6 0.22 350 / 0.14);
  --tenon-ring: oklch(1 0 0 / 0.07);
  --tenon-ink: oklch(0.98 0 0);
  --tenon-dim: oklch(0.74 0.03 277);
  --tenon-accent: oklch(0.78 0.15 277);
  --tenon-shine-mid: oklch(0.86 0.09 283);
  --tenon-shine-hot: oklch(0.76 0.17 350);
  --tenon-chip-bg: oklch(1 0 0 / 0.06);
  --tenon-chip-line: oklch(0.78 0.15 277 / 0.25);
}
.tenon-in { animation: tenon-in .62s cubic-bezier(.2,.7,.2,1) both }
@keyframes tenon-in { from { opacity:0; transform: translateY(10px) } to { opacity:1; transform:none } }
/* 标题里「咬合」那两个字的流光 */
.tenon-shine {
  background-image: linear-gradient(90deg, var(--tenon-accent) 0%, var(--tenon-shine-mid) 35%, var(--tenon-shine-hot) 50%, var(--tenon-shine-mid) 65%, var(--tenon-accent) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: tenon-shimmer 6s linear infinite;
}
@keyframes tenon-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
@media (prefers-reduced-motion: reduce) {
  .tenon-in, .tenon-shine { animation: none }
}
`

/** React 19 会按 href 去重并提到 <head>，面板和窄屏条各渲染一次也只会插一份 */
function PanelStyles() {
  return (
    <style href="tenon-panel" precedence="medium">
      {CSS}
    </style>
  )
}

const panelBg: React.CSSProperties = { background: "var(--tenon-bg)" }
const glow: React.CSSProperties = { background: "radial-gradient(closest-side, var(--tenon-glow), transparent 70%)" }
const glow2: React.CSSProperties = { background: "radial-gradient(closest-side, var(--tenon-glow-2), transparent 70%)" }

/**
 * 鼠标视差：在左栏里移动，舞台跟着俯仰 / 偏航几度。
 *
 * 只写两个 CSS 自定义属性，不走 React state —— pointermove 一秒几十次，
 * 每次重渲染 50 来个薄片 div 不值得。旋转本身和它的过渡都在 `-tenon-stage.tsx` 的 CSS 里，
 * `prefers-reduced-motion` 时那边直接把 transform 钉死，这里写不写都不影响。
 * 只认鼠标：触屏的 pointermove 是在拖，跟着转会很怪。
 */
function useTilt() {
  // 合帧：一帧里只落最后一次 pointermove
  const frame = React.useRef(0)
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      el.style.setProperty("--tilt-x", x.toFixed(3))
      el.style.setProperty("--tilt-y", y.toFixed(3))
    })
  }
  const onPointerLeave = (e: React.PointerEvent<HTMLElement>) => {
    cancelAnimationFrame(frame.current)
    e.currentTarget.style.setProperty("--tilt-x", "0")
    e.currentTarget.style.setProperty("--tilt-y", "0")
  }
  return { onPointerMove, onPointerLeave }
}

export function SignInBrandPanel() {
  const { t } = useTranslation()
  const tilt = useTilt()
  return (
    <aside
      className="tenon-panel relative hidden min-h-0 flex-col overflow-hidden text-[var(--tenon-ink)] lg:flex"
      style={panelBg}
      {...tilt}
    >
      <PanelStyles />
      <div aria-hidden className="pointer-events-none absolute top-[8%] left-[6%] size-[56rem] max-w-none" style={glow} />
      <div aria-hidden className="pointer-events-none absolute -bottom-64 -left-48 size-[38rem]" style={glow2} />

      <header className="tenon-in relative z-10 flex items-center gap-3 px-10 pt-9 xl:px-14 xl:pt-11">
        <TenonBadge className="size-8" />
        {/* 19 个字符，字距不能再拉 0.42em —— 那是给短 wordmark 的 */}
        <span className="font-mono text-sm tracking-[0.04em]">{BRAND.wordmark}</span>
      </header>

      <TenonStage />

      <div className="relative z-10 flex flex-col gap-4 px-10 pb-10 xl:px-14 xl:pb-14">
        <p
          className="tenon-in font-mono text-2xs tracking-[0.32em] text-[var(--tenon-accent)]"
          style={{ animationDelay: "120ms" }}
        >
          FASTAPI + REACT 19
        </p>
        <h2
          className="tenon-in max-w-2xl text-[clamp(2.1rem,3.6vw,3.5rem)] leading-[1.08] font-extrabold tracking-[-0.035em]"
          style={{ animationDelay: "180ms" }}
        >
          <Trans
            t={t}
            i18nKey="中后台底座，<br/>像榫卯一样<shine>咬合</shine>。"
            components={{ br: <br />, shine: <span className="tenon-shine" /> }}
          />
        </h2>
        <p
          className="tenon-in max-w-md text-sm leading-relaxed text-[var(--tenon-dim)] xl:text-[15px]"
          style={{ animationDelay: "240ms" }}
        >
          {t("组织、角色、数据范围各自成件，靠结构咬合，不靠胶水粘。改一处授权，落到每一个菜单、按钮和数据行。")}
        </p>
        {/* 同类里没人同时有的三样（见 brand.ts 顶部注释） */}
        <ul className="tenon-in mt-1 flex flex-wrap gap-2" style={{ animationDelay: "300ms" }}>
          {[t("行级数据权限"), t("保状态多页签"), t("原生 SQL Server")].map((label) => (
            <li
              key={label}
              className="flex h-7 items-center rounded-full border border-[var(--tenon-chip-line)] bg-[var(--tenon-chip-bg)] px-3 text-xs font-medium text-[var(--tenon-accent)]"
            >
              {label}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

/** 窄屏没有左栏：一条同色的品牌条，把徽章、名字和一句话定位带过去 */
export function SignInBrandStrip() {
  const { t } = useTranslation()
  return (
    <div
      className="tenon-panel relative mb-8 flex items-center gap-3 overflow-hidden rounded-2xl px-4 py-3.5 text-[var(--tenon-ink)] ring-1 ring-[var(--tenon-ring)] ring-inset lg:hidden"
      style={panelBg}
    >
      <PanelStyles />
      <div aria-hidden className="pointer-events-none absolute -top-16 -right-10 size-48" style={glow} />
      <TenonBadge className="relative size-9 shrink-0" />
      <span className="relative flex min-w-0 flex-col">
        <span className="font-mono text-xs tracking-[0.04em]">{BRAND.wordmark}</span>
        <span className="truncate text-xs text-[var(--tenon-dim)]">{t(BRAND.tagline)}</span>
      </span>
    </div>
  )
}
