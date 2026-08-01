import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireAuth } from "@admin/platform/auth/guards"

/** 沙盒页：只要登录就能进，不挂业务权限码 */
export const Route = createFileRoute("/_auth/sandbox/query")({
  validateSearch: z.object({}),
  beforeLoad: requireAuth,
  staticData: { title: "查询区（QueryBar）" },
  component: () => null,
})
