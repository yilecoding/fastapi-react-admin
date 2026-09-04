import { driver, type Driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'

import { t } from '@admin/i18n'

import { usePreferences } from '../preferences'
import { isRendered, type TourTarget } from './targets'

/**
 * 功能引导（聚焦式导览）。底层是 driver.js，这个文件是**唯一**允许 import 它的地方
 * （`arch:check` 的 `tour-lib-outside-tour-dir`），别处只拿 `TourDef` 和 `startTour()`。
 *
 * 选它而不是 react-joyride / 自研的理由，以及被排除的 Shepherd / Intro.js（AGPL），
 * 见 issue #98。这里只记会静默坏的三条：
 *
 * 1. **目标必须过 `resolveSteps()`。** driver.js 找不到目标时默认（`skipMissingElement: false`）
 *    换一个 0×0 的 `driver-dummy-element`、气泡居中、**不报错**。RBAC 把「新增」藏掉的用户
 *    会看到一个讲「点这里新增」的弹窗，而屏幕上什么都没高亮。所以启动前先解析全部步骤，
 *    找不到的丢掉；一步都不剩就不启动、也不记「看过了」。
 * 2. **`progressText` 不能套 `t()`。** driver.js 自己的占位符是 `{{current}}` / `{{total}}`，
 *    和 i18next 同形 —— 经过 `t()` 会被当成插值吃掉，屏幕上只剩一个斜杠。
 * 3. **「看过了」是人的属性，不是设备的。** 按 shell 分册「设备 vs 人」那张表它该落服务端；
 *    v1 先存 `preferences.ts`，key 带 userId 防公用机器串号 —— 代价只是换台机器多看一次，
 *    而 ⌘K 里永远能重开。落库时只动 `tourSeen` / `markTourSeen` 两个函数。
 */
export type TourStep = {
  target: TourTarget
  title: string
  description: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}

export type TourDef = {
  id: string
  /** 步骤大改就 +1 —— 看过老版本的用户会重新看到 */
  version: number
  /**
   * 函数而不是数组：文案在 `startTour()` 时才翻，切完语言下一次启动就是新语言。
   * 里面用 `@admin/i18n` 的模块级 `t()`，它读的是调用瞬间的语言（i18n 分册「模块级 t()」）。
   */
  steps: () => TourStep[]
}

/** 解析目标、丢掉找不到 / 没画出来的步骤。导出是为了让测试能单独验这一步 */
export function resolveSteps(def: TourDef): DriveStep[] {
  const out: DriveStep[] = []
  for (const step of def.steps()) {
    const el = step.target()
    if (!isRendered(el)) continue
    out.push({
      element: el,
      popover: {
        title: step.title,
        description: step.description,
        side: step.side,
        align: step.align,
      },
    })
  }
  return out
}

const seenKey = (userId: string, def: TourDef) => `${userId}:${def.id}`

export function tourSeen(userId: string, def: TourDef): boolean {
  return (usePreferences.getState().toursSeen[seenKey(userId, def)] ?? 0) >= def.version
}

export function markTourSeen(userId: string, def: TourDef): void {
  const s = usePreferences.getState()
  s.patch({ toursSeen: { ...s.toursSeen, [seenKey(userId, def)]: def.version } })
}

let current: Driver | null = null

/**
 * 启动一段导览。返回 false 表示没启动：一步目标都解析不到，或已经有一段在跑。
 *
 * 「看过了」在**启动成功的那一刻**就记，不等 `onDestroyed`。关掉（× / Esc / 点遮罩）和
 * 走完对这条记录没有区别 —— 主动关掉的人同样不想再被弹第二次。
 *
 * 🔴 之所以不放在 `onDestroyed` 里：driver.js 1.8.0 只在高亮过渡动画（`duration`，默认 400ms）
 * 跑完之后才写 `__activeElement`，而 destroy 只在有活动元素时才调 `onDestroyed` / `onDeselected`。
 * 气泡一出现就按 Esc（E2E 就是这个节奏，真人偶尔也会）落在这 400ms 里，钩子**一次都不跑**，
 * 没有报错 —— 实测：Playwright 里按 Esc 后 `localStorage.setItem` 零调用，刷新又弹一遍。
 */
export function startTour(def: TourDef, opts: { userId: string }): boolean {
  if (current?.isActive()) return false
  const steps = resolveSteps(def)
  if (!steps.length) return false

  const d = driver({
    steps,
    popoverClass: 'admin-tour',
    showProgress: true,
    // ⚠️ driver.js 自己的占位符，恰好和 i18next 同形 —— 不要套 t()，见文件头第 2 条
    progressText: '{{current}} / {{total}}',
    nextBtnText: t('下一步'),
    prevBtnText: t('上一步'),
    doneBtnText: t('完成'),
    overlayOpacity: 0.55,
    stagePadding: 6,
    stageRadius: 8,
    smoothScroll: true,
    // 导览期间不让点被高亮的元素：点开铃铛 / 用户菜单会盖在气泡上，两层浮层互相抢
    disableActiveInteraction: true,
    onDestroyed: () => {
      current = null
    },
  })
  current = d
  d.drive()
  markTourSeen(opts.userId, def)
  return true
}
