import { defineConfig } from 'vitest/config'

/**
 * 只测**纯逻辑**（上传队列的状态机、浏览器端 sha256）。理由同 `packages/ui/vitest.config.ts`：
 * 渲染层走 E2E 打真实页面，这里要的是「改了引擎之后，我改坏了没有」这个信号。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
