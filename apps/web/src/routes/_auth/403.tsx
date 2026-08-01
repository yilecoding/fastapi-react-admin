import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

/**
 * 权限不足页。
 *
 * `requirePerm` 守卫在权限校验失败时重定向到这里 —— 之前漏了建这个路由，
 * 会导致权限拒绝时跳到一个不存在的地址（tsc 抓出来的）。
 */
const searchSchema = z.object({
  from: z.string().optional(),
  need: z.string().optional(),
})

export const Route = createFileRoute("/_auth/403")({
  validateSearch: searchSchema,
  staticData: { title: "无权访问" },
  component: () => null,
})
