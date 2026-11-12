import { driver, type Driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'

import { t } from '@admin/i18n'

import { setTourActive } from './gate'
import { isRendered, type TourTarget } from './targets'

/**
 * 功能引导（聚焦式导览）。底层是 driver.js，这个文件是**唯一**允许 import 它的地方
 * （`arch:check` 的 `tour-lib-outside-tour-dir`），别处只拿 `TourDef` 和 `startTour()`。
 *
 * 选它而不是 react-joyride / 自研的理由，以及被排除的 Shepherd / Intro.js（AGPL），
 * 见 issue #98。这里只记会静默坏的两条：
 *
 * 1. **目标必须过 `resolveSteps()`。** driver.js 找不到目标时默认（`skipMissingElement: false`）
 *    换一个 0×0 的 `driver-dummy-element`、气泡居中、**不报错**。RBAC 把「新增」藏掉的用户
 *    会看到一个讲「点这里新增」的弹窗，而屏幕上什么都没高亮。所以启动前先解析全部步骤，
 *    找不到的丢掉；一步都不剩就不启动、也不记「看过了」。
 * 2. **`progressText` 不能套 `t()`。** driver.js 自己的占位符是 `{{current}}` / `{{total}}`，
 *    和 i18next 同形 —— 经过 `t()` 会被当成插值吃掉，屏幕上只剩一个斜杠。
 *
 * 不自动弹、也不记「看过了」：只有人自己从顶栏「帮助」/ ⌘K 点开才启动（shell 分册「功能引导」）。
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

let current: Driver | null = null

/** 启动一段导览。返回 false 表示没启动：一步目标都解析不到，或已经有一段在跑 */
export function startTour(def: TourDef): boolean {
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
      // 新到的公告弹窗在等它结束（`gate.ts`）
      setTourActive(false)
    },
  })
  current = d
  setTourActive(true)
  d.drive()
  return true
}
