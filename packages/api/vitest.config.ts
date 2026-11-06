import { defineConfig } from 'vitest/config'

/**
 * 只测**纯逻辑**：两端共用的判定和规则（审批表单联动、审批轨道）。
 * 这个包被 web 和移动端同时用，改坏了两端一起坏 —— 这里要的就是「改了之后，我改坏了没有」这个信号。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
