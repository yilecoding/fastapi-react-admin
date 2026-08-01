import { createFileRoute, redirect } from "@tanstack/react-router"
import { isAuthenticated } from "@admin/platform/auth/session"

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: isAuthenticated() ? "/dashboard" : "/sign-in" })
  },
})
