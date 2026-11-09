import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../fixtures/base"

/**
 * 日期 / 时间选择（#266 的 P0–P3，以及它关掉的 #264 #265）。
 *
 * 打的是组件沙箱，不是某个业务页：日期组件有四个调用方（公告、开放应用、审批表单、
 * 查询区），交互全在 `packages/ui` 里，测一次组件就替四处守住同一批行为。
 * 沙箱的演示下面把**真实的值**打成 `dt-demo-value` —— 这些用例断言的都是「值是什么」，
 * 不是「界面像不像」：草稿没提交、半截区间没丢、整月边界差一天，界面上都看不出来。
 *
 * 浮层是 portal 出去的，不在页面那个 tab 里，所以面板用 `page.getByTestId` 找；
 * 页面里的东西按 routeId 锁（硬纪律 5：隐藏的 tab 也在文档树里）。
 */

const SANDBOX = "/sandbox/components"
const TAB = '[data-tab="/_auth/sandbox/components"]'

async function openDemo(page: Page, id: "datetime-picker" | "calendar") {
  await page.goto(`${SANDBOX}?c=${id}`)
  const tab = page.locator(TAB)
  await expect(tab.getByTestId("knob-panel")).toBeVisible()
  return tab
}

/** 沙箱旋钮：单选组点那个选项的字，开关按目标状态拨 */
async function pick(tab: Locator, knob: string, option: string) {
  await tab.getByTestId(`knob-${knob}`).getByText(option, { exact: true }).click()
}
async function toggle(tab: Locator, knob: string, on: boolean) {
  const sw = tab.getByTestId(`knob-${knob}`)
  if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click()
}

/** 面板里本月（不含上下月余日）的某一天。双月时取左边那个月 */
const day = (panel: Locator, n: number) =>
  panel.locator("td:not([data-outside]) button").filter({ hasText: new RegExp(`^${n}$`) }).first()

const valueOf = async (tab: Locator) => JSON.parse((await tab.getByTestId("dt-demo-value").textContent()) ?? "null")

test.describe("日期选择 · 表头与跳转（#264 #265）", () => {
  test("🔴 中文表头是「2026年 11月」、周一开头；3 次点击跳到 3 年前的 3 月", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "calendar")
    const cal = tab.locator('[data-slot="calendar"]')
    const now = new Date()

    await expect(cal.getByTestId("calendar-year")).toHaveText(`${now.getFullYear()}年`)
    await expect(cal.getByTestId("calendar-month")).toHaveText(`${now.getMonth() + 1}月`)
    // zhCN 的 weekStartsOn 是 1：第一列是「一」，不是英文的 Su
    await expect(cal.locator("thead th").first()).toHaveText("一")

    const target = now.getFullYear() - 3
    await cal.getByTestId("calendar-year").click() // 1
    const yearCell = cal.getByTestId("calendar-year-panel").locator(`[data-cell="${target}"]`)
    // 年面板是「上个十年最后一年 + 十年 + 下个十年第一年」：个位 ≤ 1 的年份往回 3 年会落在面板外，要先翻一页
    if (!(await yearCell.count())) await cal.getByRole("button", { name: "前十年" }).click()
    await yearCell.click() // 2
    await cal.getByTestId("calendar-month-panel").locator('[data-cell="2"]').click() // 3

    await expect(cal).toHaveAttribute("data-view", "day")
    await expect(cal.getByTestId("calendar-year")).toHaveText(`${target}年`)
    await expect(cal.getByTestId("calendar-month")).toHaveText("3月")
  })

  test("🔴 单值选择器能一路翻到明年 —— 不再被锁在今年 12 月（#264）", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "单值")
    await tab.getByTestId("dt-demo").click()
    const panel = page.getByTestId("dt-demo-panel")
    const next = panel.getByRole("button", { name: "下个月" })

    // 不管今天是几月，往后翻 13 个月一定跨过年底；每一下都必须是可点的
    for (let i = 0; i < 13; i++) {
      await expect(next).toBeEnabled()
      await next.click()
    }
    await expect(panel.getByTestId("calendar-year")).toHaveText(`${new Date().getFullYear() + 1}年`)
  })
})

test.describe("日期选择 · 单值（草稿 / 确定 / 手输）", () => {
  test("🔴 带时间：点的先进草稿，Esc 丢掉；点「确定」才提交", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "单值")
    await toggle(tab, "withTime", true)
    const input = tab.getByTestId("dt-demo")
    const panel = page.getByTestId("dt-demo-panel")

    await input.click()
    await day(panel, 20).click()
    await panel.locator('[data-unit="hour"] [data-value="14"]').click()
    await panel.locator('[data-unit="minute"] [data-value="30"]').click()
    // 输入框跟着草稿走，但值没动
    await expect(input).toHaveValue(/-20 14:30:00$/)
    expect(await valueOf(tab)).toBeNull()

    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    await expect(input).toHaveValue("")
    expect(await valueOf(tab)).toBeNull()

    await input.click()
    await day(panel, 20).click()
    await panel.locator('[data-unit="hour"] [data-value="9"]').click()
    await panel.getByTestId("dt-demo-ok").click()
    await expect(panel).toBeHidden()
    expect(await valueOf(tab)).toMatch(/^\d{4}-\d{2}-20 09:00:00$/)
  })

  test("🔴 手输：回车提交并跳到那个月；不存在的日期标红、不提交，点外面恢复原值", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "单值")
    await toggle(tab, "withTime", true)
    const input = tab.getByTestId("dt-demo")
    const panel = page.getByTestId("dt-demo-panel")

    await input.click()
    await input.pressSequentially("2027/3/5 8:15")
    // 敲到合法就预览：日历跳到 2027 年 3 月、5 号选中，但还没提交
    await expect(panel.getByTestId("calendar-year")).toHaveText("2027年")
    await expect(panel.getByTestId("calendar-month")).toHaveText("3月")
    await expect(panel.locator('[data-selected-single="true"]')).toHaveText("5")
    expect(await valueOf(tab)).toBeNull()
    await input.press("Enter")
    await expect(panel).toBeHidden()
    expect(await valueOf(tab)).toBe("2027-03-05 08:15:00")

    await input.fill("2026-02-30")
    await input.press("Enter")
    await expect(input).toHaveAttribute("aria-invalid", "true")
    await expect(panel).toBeVisible()
    expect(await valueOf(tab)).toBe("2027-03-05 08:15:00")

    await tab.getByTestId("knob-panel").click({ position: { x: 2, y: 2 } })
    await expect(panel).toBeHidden()
    await expect(input).toHaveValue("2027-03-05 08:15:00")
    await expect(input).not.toHaveAttribute("aria-invalid")
  })

  test("按月：先进年面板选年、再选月，值是 YYYY-MM", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "单值")
    await pick(tab, "picker", "month")
    await tab.getByTestId("dt-demo").click()
    const panel = page.getByTestId("dt-demo-panel")

    await panel.getByTestId("calendar-year").click()
    await panel.getByTestId("calendar-year-panel").locator('[data-cell="2028"]').click()
    await panel.getByTestId("calendar-month-panel").locator('[data-cell="4"]').click()
    expect(await valueOf(tab)).toBe("2028-05")
  })
})

test.describe("日期选择 · 区间（重选 / 预览 / 丢半截）", () => {
  test("🔴 第一下不提交；选好再点是重新开始；只点了一端就关掉，那一端丢掉", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "区间")
    await toggle(tab, "withTime", false)
    const trigger = tab.getByTestId("dt-demo")
    const panel = page.getByTestId("dt-demo-panel")

    await trigger.click()
    await day(panel, 1).click()
    // 原来第一下就提交成 `[d, d]`（#266 实测）
    expect(await valueOf(tab)).toBeNull()
    await day(panel, 10).click()
    await expect(panel).toBeHidden()
    const done = await valueOf(tab)
    expect(done[0]).toMatch(/-01$/)
    expect(done[1]).toMatch(/-10$/)

    // 再点 20：从 20 重新开始，不是把原区间拉长成 1 ~ 20
    await trigger.click()
    await day(panel, 20).click()
    await expect(panel.getByTestId("dt-demo-start")).toHaveValue(/-20$/)
    await expect(panel.getByTestId("dt-demo-end")).toHaveValue("")
    // 等第二下时悬停预览
    await day(panel, 25).hover()
    await expect(panel.locator("[data-previewing]")).toHaveCount(1)
    await expect(panel.locator('[data-range-end="true"]').first()).toHaveText("25")

    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    expect(await valueOf(tab)).toEqual(done)
  })

  test("🔴 带时间：嵌在面板里的时间选择不会把外面的浮层关掉；「确定」后两端带上时间", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "区间")
    await toggle(tab, "withTime", true)
    const panel = page.getByTestId("dt-demo-panel")

    await tab.getByTestId("dt-demo").click()
    await day(panel, 3).click()
    await day(panel, 6).click()
    // 带时间时第二下不提交，等「确定」
    await expect(panel).toBeVisible()
    expect(await valueOf(tab)).toBeNull()

    await panel.getByTestId("dt-demo-start-time").click()
    const inner = page.getByTestId("dt-demo-start-time-panel")
    await inner.locator('[data-unit="hour"] [data-value="5"]').click()
    await inner.getByTestId("dt-demo-start-time-ok").click()
    await expect(inner).toBeHidden()
    await expect(panel).toBeVisible()

    await panel.getByTestId("dt-demo-ok").click()
    await expect(panel).toBeHidden()
    const [a, b] = await valueOf(tab)
    expect(a).toMatch(/-03 05:00:00$/)
    expect(b).toMatch(/-06 23:59:59$/)
  })

  test("按月区间：值取整段边界（月初 ~ 月末）", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "区间")
    await toggle(tab, "withTime", false)
    await pick(tab, "picker", "month")
    const panel = page.getByTestId("dt-demo-panel")

    await tab.getByTestId("dt-demo").click()
    // 按月 / 按年时没有快捷区间
    await expect(panel.getByTestId("dt-demo-preset-today")).toHaveCount(0)
    const months = panel.getByTestId("calendar-month-panel")
    await months.locator('[data-cell="0"]').click()
    await months.locator('[data-cell="1"]').click()
    const [a, b] = await valueOf(tab)
    expect(a).toMatch(/^\d{4}-01-01$/)
    // 2 月的最后一天按那年算（28 或 29），不是写死的 30 / 31
    expect(b).toMatch(/^\d{4}-02-2[89]$/)
  })
})

test.describe("时间选择 · TimePicker", () => {
  test("🔴 三列按步长出格子；点选进草稿、「确定」提交；手输 1405 回车 = 14:05:00", async ({ authedPage: page }) => {
    const tab = await openDemo(page, "datetime-picker")
    await pick(tab, "mode", "时间")
    const input = tab.getByTestId("dt-demo")
    const panel = page.getByTestId("dt-demo-panel")

    await input.click()
    // 沙箱里 minuteStep=5
    await expect(panel.locator('[data-unit="minute"] [data-value]').nth(1)).toHaveAttribute("data-value", "5")
    await panel.locator('[data-unit="hour"] [data-value="9"]').click()
    await panel.locator('[data-unit="minute"] [data-value="45"]').click()
    expect(await valueOf(tab)).toBeNull()
    await panel.getByTestId("dt-demo-ok").click()
    expect(await valueOf(tab)).toBe("09:45:00")

    await input.fill("1405")
    await input.press("Enter")
    expect(await valueOf(tab)).toBe("14:05:00")
  })
})
