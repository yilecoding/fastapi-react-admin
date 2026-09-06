import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * 单测只覆盖**纯逻辑**：三态级联、URL 序列化、网格列状态、翻译兜底。
 *
 * 刻意**不做组件渲染测试**（没有 jsdom / testing-library）：
 * 渲染层的验证走 E2E 打真实页面（`apps/web/e2e/`），那一层已经有 69 条用例，
 * 再补一套 jsdom 的渲染断言是同一件事验两遍，而 jsdom 和真浏览器的差异
 * （布局、`getBoundingClientRect`、Base UI 的浮层定位）恰恰在这个库最要紧的
 * 那些坑上是**不一致**的 —— tooltip 定位那条坑 jsdom 根本测不出来。
 *
 * 这里要的是另一件 E2E 给不了的东西：**下家改了组件之后，「我改坏了没有」
 * 这个信号**。所以选的都是「边界条件多、改错了不报错」的纯函数。
 */
export default defineConfig({
  resolve: {
    alias: { '@admin/ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
