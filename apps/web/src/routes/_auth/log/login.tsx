import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/**
 * 筛选参数的键 = `pages/log-login` 里 `FIELDS` 的 `key`，**不是接口入参名**。
 *
 * 老的 schema 直接用 `start_time` / `end_time`，地址栏于是长这样：
 * `?start_time=2026-08-16+00%3A00%3A00&end_time=2026-08-22+23%3A59%3A59&page=1`
 * —— 74 个字符里时分秒是派生的、`page=1` 是默认值、`+` `%3A` 是编码噪音。
 * 现在一个时间范围就是一个 `time=2026-08-16~2026-08-22`，
 * 补时分秒和拆成两个入参都发生在请求那一侧（见 `query-bar/params.ts`）。
 */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  username: z.string().optional(),
  ip: z.string().optional(),
  status: z.coerce.number().int().optional(),
  /** `2026-08-16~2026-08-22`，两端都可省（`~b` / `a~`） */
  time: z.string().optional(),
  /** 摆开但还没填值的格子，逗号分隔；运算符不是默认值时写成 `key:op` */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔（视图状态进 URL） */
  hide: z.string().optional(),
  // 没有 `adv`：日志页没开 `advanced`（后端没有过滤 DSL），
  // 留一个用不上的字段只会让下一个人以为它有用（见「已经删掉的东西」那一节）
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/log/login")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("log:login:del"),
  staticData: { title: "登录日志" },
  component: () => null,
})
