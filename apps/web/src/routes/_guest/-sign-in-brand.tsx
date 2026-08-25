import { useTranslation } from 'react-i18next'
/**
 * 登录页左栏：品牌面板。
 *
 * 它**跟随主题** —— 浅色下是一块比右栏略低一档的浅面，深色下才是近黑。
 * 早先试过让它固定近黑，结果浅色主题下就是一块黑板贴在白页上，两边没有关系。
 *
 * 一整套色都走 `.tenon-panel` 上的自定义属性，深色分支交给 `.dark .tenon-panel`：
 * 纯 CSS 切换，不用把主题状态读进 React。
 *
 * 文件名带 `-` 前缀，TanStack Router 的文件路由会跳过它（同 routes/-404.tsx）。
 */
import type * as React from "react"

import { TenonMark } from "@/components/tenon-mark"
import { BRAND } from "@/lib/brand"

const CSS = `
.tenon-panel {
  /* 浅色：比右栏的纯白低一档，才读得出「这是一块面板」 */
  --tenon-panel: oklch(0.976 0.004 277);
  --tenon-node: oklch(1 0 0);            /* 纯白节点，靠明度差浮起，不靠投影 */
  --tenon-node-line: oklch(0.145 0 0 / 0.14);
  --tenon-edge: oklch(0.145 0 0 / 0.24);
  --tenon-grid: oklch(0.145 0 0 / 0.05);
  --tenon-line: oklch(0.145 0 0 / 0.09);
  --tenon-ring: oklch(0.145 0 0 / 0.08);
  --tenon-ink: oklch(0.145 0 0);
  --tenon-dim: oklch(0.44 0.01 277);
  --tenon-faint: oklch(0.55 0.012 277);
  --tenon-accent: oklch(0.457 0.24 277);
  --tenon-halo: oklch(0.457 0.24 277 / 0.25);
  --tenon-glow: oklch(0.6 0.2 277 / 0.09);
  --tenon-noise: 0.03;
}
.dark .tenon-panel {
  --tenon-panel: oklch(0.155 0.014 277);
  --tenon-node: oklch(0.205 0.016 277);
  --tenon-node-line: oklch(1 0 0 / 0.14);
  --tenon-edge: oklch(1 0 0 / 0.2);
  --tenon-grid: oklch(1 0 0 / 0.055);
  --tenon-line: oklch(1 0 0 / 0.08);
  --tenon-ring: oklch(1 0 0 / 0.07);
  --tenon-ink: oklch(0.98 0 0);
  --tenon-dim: oklch(0.7 0.012 277);
  --tenon-faint: oklch(0.52 0.014 277);
  --tenon-accent: oklch(0.78 0.15 277);
  --tenon-halo: oklch(0.72 0.17 277 / 0.55);
  --tenon-glow: oklch(0.72 0.17 277 / 0.22);
  --tenon-noise: 0.045;
}
.tenon-in { animation: tenon-in .62s cubic-bezier(.2,.7,.2,1) both }
@keyframes tenon-in { from { opacity:0; transform: translateY(10px) } to { opacity:1; transform:none } }
/* pathLength=100 把三段连线归一化，脉冲在长短不同的路径上速度一致 */
.tenon-flow {
  fill:none; stroke:var(--tenon-accent); stroke-width:1.6; stroke-linecap:round;
  stroke-dasharray:2 98; animation: tenon-flow 2.9s linear infinite;
  filter: drop-shadow(0 0 4px var(--tenon-halo));
}
@keyframes tenon-flow { from { stroke-dashoffset:0 } to { stroke-dashoffset:-100 } }
@media (prefers-reduced-motion: reduce) {
  .tenon-in { animation:none }
  .tenon-flow { animation:none; stroke-dasharray:none; opacity:.28 }
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

const grid: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(to right, var(--tenon-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--tenon-grid) 1px, transparent 1px)",
  backgroundSize: "38px 38px",
  maskImage: "radial-gradient(140% 120% at 6% 0%, black 40%, transparent 100%)",
  WebkitMaskImage: "radial-gradient(140% 120% at 6% 0%, black 40%, transparent 100%)",
}

// 胶片颗粒。大面积纯色会显得很平，一点噪点就把「印刷品」的质感带回来
const noise: React.CSSProperties = {
  opacity: "var(--tenon-noise)",
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")",
}

const glow: React.CSSProperties = {
  background: "radial-gradient(closest-side, var(--tenon-glow), transparent)",
}

/**
 * 授权链路上的一级。
 *
 * ⚠️ `caption` 的译文有长度上限：viewBox 是 560 宽，右侧两级从 x=368 起排，
 * 12px 下大约 28 个拉丁字符就会被 viewBox 裁掉（中文短、英文长，只有切英文才看得出来）。
 */
type Stage = {
  /** 序号：这条链是真有先后的，编号不是装饰 */
  index: string
  /** 该级在导轨上的起点 */
  x: number
  /** 所在导轨的 y */
  y: number
  label: string
  caption: string
}

// 一条导轨：既是每一级的下划线，也是级与级之间的连线。
// 面板别处的结构件就是发丝横线（wordmark 下、技术栈上），示意图说同一套话。
const RULE_Y = 118
const FORK_X = 320
const UP_Y = 52
const DOWN_Y = 184
const RIGHT = 560
const STAGES: Stage[] = [
  { index: "01", x: 0, y: RULE_Y, label: "用户", caption: "谁在登录" },
  { index: "02", x: 176, y: RULE_Y, label: "角色", caption: "授权的单位" },
  { index: "03", x: 368, y: UP_Y, label: "菜单 · 按钮", caption: "能进哪、能点哪" },
  { index: "04", x: 368, y: DOWN_Y, label: "数据范围", caption: "能看到哪些行" },
]

// 用户 → 角色 走同一根导轨，到 FORK_X 分岔成「能进哪」和「能看到哪些行」两条
const RAILS = [
  `M0 ${RULE_Y} H${FORK_X}`,
  `M${FORK_X} ${RULE_Y} V${UP_Y} H${RIGHT}`,
  `M${FORK_X} ${RULE_Y} V${DOWN_Y} H${RIGHT}`,
]

/**
 * 签名元素：这个后台真实的授权链路。
 * 不是装饰图形 —— 每一级对应的就是 role / menu / data-scope 那套东西。
 */
function AuthChain() {
  const { t } = useTranslation()
  return (
    <svg
      viewBox="0 0 560 214"
      className="tenon-in w-full max-w-[680px] 2xl:max-w-[820px]"
      style={{ animationDelay: "220ms" }}
      role="img"
      aria-label={t("授权链路：用户经角色拿到菜单与按钮权限，以及数据范围")}
    >
      {RAILS.map((d, i) => (
        <g key={d}>
          <path d={d} fill="none" stroke="var(--tenon-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {/* 脉冲跑在同一条导轨上：光从字底下穿过去 */}
          <path
            d={d}
            pathLength={100}
            className="tenon-flow"
            style={{ animationDelay: `${i * 0.34}s` }}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
      {/* 分岔点做成一枚实心销，比一个光秃秃的折角更像图纸 */}
      <rect x={FORK_X - 2.5} y={RULE_Y - 2.5} width="5" height="5" rx="1" fill="var(--tenon-accent)" />

      {STAGES.map((st) => (
        <g key={st.index}>
          {/* 刻度：把这一级钉在导轨上的那一竖 */}
          <path
            d={`M${st.x} ${st.y} V${st.y - 9}`}
            stroke="var(--tenon-edge)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {/* 序号、标签、说明共用同一条左边界（也就是标题的左边界）——
              窄屏把序号和说明藏掉时，标签正好落在刻度上，不会留下悬空的缩进 */}
          <text
            x={st.x}
            y={st.y - 34}
            className="font-mono max-xl:hidden"
            fontSize="10.5"
            letterSpacing="1.4"
            fill="var(--tenon-faint)"
          >
            {st.index}
          </text>
          {/* 标签坐在导轨上，说明挂在导轨下 —— 那条线同时是两者的分界 */}
          <text x={st.x} y={st.y - 12} fontSize="16.5" fontWeight="500" fill="var(--tenon-ink)">
            {t(st.label)}
          </text>
          <text x={st.x} y={st.y + 18} className="max-xl:hidden" fontSize="12" fill="var(--tenon-faint)">
            {t(st.caption)}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function SignInBrandPanel() {
  const { t } = useTranslation()
  return (
    <aside className="relative hidden p-3 lg:block">
      <div className="tenon-panel relative flex h-full flex-col overflow-hidden rounded-[26px] bg-[var(--tenon-panel)] text-[var(--tenon-ink)] ring-1 ring-[var(--tenon-ring)] ring-inset">
        <PanelStyles />
        <div aria-hidden className="pointer-events-none absolute inset-0" style={grid} />
        <div aria-hidden className="pointer-events-none absolute -top-48 -left-32 size-[38rem]" style={glow} />
        <div aria-hidden className="pointer-events-none absolute inset-0" style={noise} />

        <div className="relative flex flex-1 flex-col px-10 py-9 xl:px-14 xl:py-11">
          <div className="tenon-in flex items-center gap-4">
            <span className="flex items-center gap-3">
              <TenonMark className="size-[26px]" />
              {/* 19 个字符，字距不能再拉 0.42em —— 那是给短 wordmark 的 */}
              <span className="font-mono text-sm tracking-[0.06em]">{BRAND.wordmark}</span>
            </span>
          </div>

          <div className="mt-7 h-px bg-[var(--tenon-line)]" />

          <div className="flex flex-1 flex-col justify-center gap-12 py-6">
            <header>
              <p
                className="tenon-in font-mono text-2xs tracking-[0.32em] text-[var(--tenon-accent)]"
                style={{ animationDelay: "60ms" }}
              >
                {t("权限与数据的承重层")}
              </p>
              <h2
                className="tenon-in mt-5 max-w-xl text-[clamp(1.85rem,2.9vw,2.65rem)] leading-[1.16] font-semibold tracking-[-0.03em]"
                style={{ animationDelay: "110ms" }}
              >
                {t("一个入口，管好权限与数据")}
              </h2>
              <p
                className="tenon-in mt-4 max-w-md text-sm leading-relaxed text-[var(--tenon-dim)]"
                style={{ animationDelay: "160ms" }}
              >
                {t("组织、角色和数据范围各自成件，靠结构咬合：改一处授权，落到每一个菜单、按钮和数据行。")}
              </p>
            </header>

            <AuthChain />
          </div>

          <div className="h-px bg-[var(--tenon-line)]" />
          <div
            className="tenon-in mt-5 flex items-center justify-between gap-4 font-mono text-2xs tracking-[0.2em] text-[var(--tenon-faint)]"
            style={{ animationDelay: "300ms" }}
          >
            <span className="min-w-0 truncate">{BRAND.stack.join("  ·  ")}</span>
            <span className="shrink-0">{BRAND.version}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

/** 窄屏没有左栏，用一条同色的面板条把标识带过去 */
export function SignInBrandStrip() {
  return (
    <div className="tenon-panel mb-8 flex items-center gap-3 rounded-2xl bg-[var(--tenon-panel)] px-4 py-3.5 text-[var(--tenon-ink)] ring-1 ring-[var(--tenon-ring)] ring-inset lg:hidden">
      <PanelStyles />
      <span className="flex items-center gap-2.5">
        <TenonMark className="size-5" />
        <span className="font-mono text-xs tracking-[0.04em]">{BRAND.wordmark}</span>
      </span>
    </div>
  )
}
