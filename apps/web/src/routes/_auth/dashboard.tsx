import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

const searchSchema = z.object({
  /**
   * 公告卡片里就地打开的那一条（#186，硬纪律 2：开着哪条进 URL，刷新还在）。
   * 雪花 ID 一律字符串（硬纪律 6）；`coerce` 兜 `?notice=123` 这种被解析成 number 的小数字
   */
  notice: z.coerce.string().optional(),
})

/**
 * 页面组件不在这里渲染 —— 由 TabOutlet 统一挂载（见 _auth.tsx）。
 * 这里只负责：search schema、staticData、权限守卫。
 *
 * 不挂权限码：工作台是登录后的落地页，公告卡片要对所有人可见（#186）；
 * 其余卡片各自按接口权限显示「没有权限」。
 */
export const Route = createFileRoute("/_auth/dashboard")({
  validateSearch: searchSchema,
  staticData: { title: "仪表盘" },
  component: () => null,
})
