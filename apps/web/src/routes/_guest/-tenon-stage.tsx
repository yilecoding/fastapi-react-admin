/**
 * 登录页左栏的签名元素：一枚立体的榫卯。
 *
 * 和侧边栏 / 标签页里那枚是**同一份轮廓**（`TENON_OUTLINE` / `MORTISE_OUTLINE`），只是
 * 叠出了厚度、放进了等轴视角：榫沿着地面那条主轴反复滑向卯眼，最近时只差一线、
 * 舌尖亮起一道光缝，然后退开 —— 「即将咬合」而不是「已经拼死」，和 `TenonMark` 说的是同一件事。
 *
 * 实现是纯 CSS 3D，不引 three.js：每片零件由 `LAYERS` 层 `clip-path` 薄片沿 Z 轴叠成，
 * 顶上再盖一层带光照方向的顶面。没有 canvas、没有 WebGL 上下文，深浅主题只是换一组自定义属性。
 *
 * 尺寸全部走容器查询单位（`cqw`）：舞台边长随左栏宽高变，薄片间距、阴影模糊、
 * 下落高度跟着等比缩放 —— 写死 px 的话，1024 宽的窄左栏里零件会厚得像砖。
 *
 * 文件名带 `-` 前缀，TanStack Router 的文件路由会跳过它（同 routes/-404.tsx）。
 */
import type * as React from "react"

import { MORTISE_OUTLINE, TENON_OUTLINE, type Outline } from "@/components/tenon-outline"

const toPolygon = (pts: Outline) =>
  `polygon(${pts.map(([x, y]) => `${(x / 24) * 100}% ${(y / 24) * 100}%`).join(", ")})`

const TENON_CLIP = toPolygon(TENON_OUTLINE)
const MORTISE_CLIP = toPolygon(MORTISE_OUTLINE)

/**
 * 每片零件的薄片层数。零件厚度固定为舞台边长的 22/300（`--tenon-depth`），
 * 层数只决定侧面有多「实」：实测 22 层时舞台到 600px（1920 宽屏），窄的榫舌侧面
 * 在俯角下露出一条条细缝；30 层只剩极淡的细纹。再加层数是拿 DOM 换观感，两片共 60 层已够。
 * CSS 里的 `--tenon-layers` 由这里注入。
 */
const LAYERS = 30
const SLICES = Array.from({ length: LAYERS }, (_, i) => i)

const CSS = `
.tenon-stage-wrap { container-type: size }
.tenon-stage-box {
  /* 浅色：榫是品牌紫，卯是同色相的浅紫 —— 对应图标里卯那片 0.45 的透明度 */
  --tenon-layers: ${LAYERS};
  --tenon-depth: calc(100cqw * 22 / 300);
  --tenon-step: calc(var(--tenon-depth) / var(--tenon-layers));
  --tenon-t-lo: oklch(0.27 0.15 277);
  --tenon-t-hi: oklch(0.38 0.2 277);
  --tenon-t-top: linear-gradient(135deg, oklch(0.56 0.22 280) 0%, oklch(0.457 0.24 277) 48%, oklch(0.41 0.22 277) 100%);
  --tenon-m-lo: oklch(0.6 0.13 280);
  --tenon-m-hi: oklch(0.72 0.11 282);
  --tenon-m-top: linear-gradient(135deg, oklch(0.93 0.03 285) 0%, oklch(0.86 0.065 283) 50%, oklch(0.79 0.095 282) 100%);
  --tenon-t-sheen: oklch(1 0 0 / 0.45);
  --tenon-m-sheen: oklch(1 0 0 / 0.7);
  --tenon-shadow: oklch(0.457 0.24 277);
  --tenon-t-shadow-a: 0.38;
  --tenon-m-shadow-a: 0.22;
  --tenon-floor: oklch(0.457 0.24 277 / 0.13);
  --tenon-axis: oklch(0.457 0.24 277 / 0.45);
  --tenon-seam-core: oklch(1 0 0);
  --tenon-seam-edge: oklch(0.8 0.1 285);
  --tenon-seam-glow: oklch(0.62 0.2 280 / 0.6);

  position: relative;
  width: min(86cqw, 86cqh, 600px);
  aspect-ratio: 1;
  container-type: inline-size;
  animation: tenon-fade .9s ease-out both, tenon-float 5.5s ease-in-out 1s infinite alternate;
}
.dark .tenon-stage-box {
  --tenon-t-lo: oklch(0.2 0.12 277);
  --tenon-t-hi: oklch(0.33 0.18 277);
  --tenon-t-top: linear-gradient(135deg, oklch(0.64 0.2 282) 0%, oklch(0.52 0.24 277) 50%, oklch(0.43 0.22 277) 100%);
  --tenon-m-lo: oklch(0.34 0.1 280);
  --tenon-m-hi: oklch(0.47 0.12 282);
  --tenon-m-top: linear-gradient(135deg, oklch(0.8 0.09 285) 0%, oklch(0.7 0.12 283) 50%, oklch(0.62 0.14 282) 100%);
  --tenon-t-sheen: oklch(1 0 0 / 0.3);
  --tenon-m-sheen: oklch(1 0 0 / 0.4);
  --tenon-shadow: oklch(0.5 0.24 277);
  --tenon-t-shadow-a: 0.5;
  --tenon-m-shadow-a: 0.32;
  --tenon-floor: oklch(0.78 0.15 277 / 0.12);
  --tenon-axis: oklch(0.78 0.15 277 / 0.4);
  --tenon-seam-edge: oklch(0.82 0.11 285);
  --tenon-seam-glow: oklch(0.72 0.2 280 / 0.75);
}
/* perspective 单独放一层：写在 .tenon-stage-box 自己身上的话，cqw 会按**外层**容器算 */
.tenon-stage-lens { position: absolute; inset: 0; perspective: 320cqw }
.tenon-stage {
  position: absolute; inset: 0; transform-style: preserve-3d;
  /* --tilt-x / --tilt-y 由左栏的 pointermove 写入，范围 -0.5..0.5 */
  transform: rotateX(calc(58deg - var(--tilt-y, 0) * 8deg)) rotateZ(calc(-32deg + var(--tilt-x, 0) * 10deg));
  transition: transform .7s cubic-bezier(.2,.7,.2,1);
}
.tenon-floor {
  position: absolute; left: -60%; top: -60%; width: 220%; height: 220%;
  transform: translateZ(-0.4cqw);
  background-image:
    linear-gradient(to right, var(--tenon-floor) 1px, transparent 1px),
    linear-gradient(to bottom, var(--tenon-floor) 1px, transparent 1px);
  /* 格距 = 图标里的 2 个单位；起点偏移 60cqw，让网格线正好压在零件的边上 */
  background-size: calc(100cqw / 12) calc(100cqw / 12);
  background-position: 60cqw 60cqw;
  -webkit-mask-image: radial-gradient(45% 45% at 50% 50%, #000 20%, transparent 100%);
  mask-image: radial-gradient(45% 45% at 50% 50%, #000 20%, transparent 100%);
}
.tenon-axis {
  position: absolute; left: -10%; top: 50%; width: 120%; height: 1px;
  transform: translateZ(-0.2cqw);
  background: linear-gradient(90deg, transparent, var(--tenon-axis) 30%, var(--tenon-axis) 70%, transparent);
}
.tenon-piece {
  position: absolute; inset: 0; transform-style: preserve-3d;
  animation: tenon-drop 1.1s cubic-bezier(.2,.8,.2,1) both;
}
.tenon-piece--t { --lo: var(--tenon-t-lo); --hi: var(--tenon-t-hi); --top: var(--tenon-t-top); --sheen: var(--tenon-t-sheen); --shadow-a: var(--tenon-t-shadow-a) }
.tenon-piece--m { --lo: var(--tenon-m-lo); --hi: var(--tenon-m-hi); --top: var(--tenon-m-top); --sheen: var(--tenon-m-sheen); --shadow-a: var(--tenon-m-shadow-a); animation-delay: .12s }
.tenon-slide { position: absolute; inset: 0; transform-style: preserve-3d }
.tenon-piece--t .tenon-slide { animation: tenon-slide-t 4.4s cubic-bezier(.65,0,.35,1) 1.2s infinite alternate both }
.tenon-piece--m .tenon-slide { animation: tenon-slide-m 4.4s cubic-bezier(.65,0,.35,1) 1.2s infinite alternate both }
.tenon-shadow {
  position: absolute; inset: 0; background: var(--tenon-shadow); opacity: var(--shadow-a);
  filter: blur(4cqw); transform: translateZ(-0.3cqw);
}
/* 底层压暗、顶层提亮：侧面自带一点环境光遮蔽 */
.tenon-slice {
  position: absolute; inset: 0;
  transform: translateZ(calc(var(--i) * var(--tenon-step)));
  background: color-mix(in oklab, var(--hi) calc(var(--i) / (var(--tenon-layers) - 1) * 100%), var(--lo));
}
.tenon-top { position: absolute; inset: 0; background: var(--top); transform: translateZ(var(--tenon-depth)) }
.tenon-sheen {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, var(--sheen), transparent 40%);
  transform: translateZ(calc(var(--tenon-depth) + 0.1cqw));
}
/* 光缝：贴在榫舌尖端的顶面上，跟着榫一起走；地面上再落一团光 */
.tenon-seam, .tenon-seam-glow { position: absolute; top: 37.5%; height: 25%; opacity: 0; animation: tenon-seam 4.4s cubic-bezier(.65,0,.35,1) 1.2s infinite alternate both }
.tenon-seam {
  left: calc(${(13 / 24) * 100}% - 0.35cqw); width: 0.7cqw; border-radius: 1cqw;
  transform: translateZ(calc(var(--tenon-depth) + 0.2cqw));
  background: linear-gradient(180deg, transparent, var(--tenon-seam-edge) 18%, var(--tenon-seam-core) 50%, var(--tenon-seam-edge) 82%, transparent);
  box-shadow: 0 0 3cqw 0.8cqw var(--tenon-seam-glow);
}
.tenon-seam-glow {
  left: ${(13 / 24) * 100}%; width: 9cqw;
  transform: translateZ(0.1cqw);
  background: radial-gradient(closest-side, var(--tenon-seam-glow), transparent);
}
@keyframes tenon-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes tenon-float { from { transform: translateY(0) } to { transform: translateY(-1.6cqw) } }
/* 只动 transform：preserve-3d 的元素上一旦有 opacity < 1，整组会被拍扁成一张平面 */
@keyframes tenon-drop { from { transform: translateZ(40cqw) } to { transform: none } }
/* 榫：最近时舌尖离卯眼只剩约 2% 边长 —— 永远差一点，不真的咬死 */
@keyframes tenon-slide-t { from { transform: translateX(-24%) } to { transform: translateX(6%) } }
/* 卯：往回迎一小段，两片都是活的 */
@keyframes tenon-slide-m { from { transform: translateX(4%) } to { transform: none } }
@keyframes tenon-seam { 0%, 55% { opacity: 0 } 100% { opacity: 1 } }
/* 🔴 选择器要和上面挂动画的那几条同样具体：写成裸 \`.tenon-slide\` 的话，
   \`.tenon-piece--t .tenon-slide\` 的动画照跑，减弱动效时榫块停在最远处（实测踩过） */
@media (prefers-reduced-motion: reduce) {
  .tenon-stage-box, .tenon-piece, .tenon-piece--t .tenon-slide, .tenon-piece--m .tenon-slide, .tenon-seam, .tenon-seam-glow { animation: none }
  .tenon-stage { transition: none; transform: rotateX(58deg) rotateZ(-32deg) }
  .tenon-piece--t .tenon-slide { transform: translateX(3%) }
  .tenon-seam, .tenon-seam-glow { opacity: 0.5 }
}
`

function StageStyles() {
  return (
    <style href="tenon-stage" precedence="medium">
      {CSS}
    </style>
  )
}

function Piece({ kind, clip }: { kind: "t" | "m"; clip: string }) {
  const clipStyle: React.CSSProperties = { clipPath: clip }
  return (
    <div className={`tenon-piece tenon-piece--${kind}`}>
      <div className="tenon-slide">
        <div className="tenon-shadow" style={clipStyle} />
        {SLICES.map((i) => (
          <div key={i} className="tenon-slice" style={{ ...clipStyle, "--i": i } as React.CSSProperties} />
        ))}
        <div className="tenon-top" style={clipStyle} />
        <div className="tenon-sheen" style={clipStyle} />
        {kind === "t" && (
          <>
            <div className="tenon-seam-glow" />
            <div className="tenon-seam" />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 舞台本身。外层要给它一个有高度的 flex 区域（`.tenon-stage-wrap`）——
 * 边长取那块区域宽、高里较小的那个，再封顶 600px。
 */
export function TenonStage() {
  return (
    <div aria-hidden className="tenon-stage-wrap pointer-events-none flex min-h-0 flex-1 items-center justify-center">
      <StageStyles />
      <div className="tenon-stage-box">
        <div className="tenon-stage-lens">
          <div className="tenon-stage">
            <div className="tenon-floor" />
            <div className="tenon-axis" />
            <Piece kind="t" clip={TENON_CLIP} />
            <Piece kind="m" clip={MORTISE_CLIP} />
          </div>
        </div>
      </div>
    </div>
  )
}
