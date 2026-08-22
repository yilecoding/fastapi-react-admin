import type { PageRegistry } from "@admin/platform/shell/tab-outlet"
import { UserPage } from "@admin/platform/pages/user"
import { LogLoginPage } from "@admin/platform/pages/log-login"
import { LogOperaPage } from "@admin/platform/pages/log-opera"
import { DeptPage } from "@admin/platform/pages/dept"
import { RolePage } from "@admin/platform/pages/role"
import { DictPage } from "@admin/platform/pages/dict"
import { DataPermissionPage } from "@admin/platform/pages/data-permission"
import { MenuPage } from "@admin/platform/pages/menu"
import { FilePage } from "@admin/platform/pages/file"
import { ConfigPage } from "@admin/platform/pages/config"
import { LogOnlinePage } from "@admin/platform/pages/log-online"
import { MonitorRedisPage } from "@admin/platform/pages/monitor-redis"
import { MonitorServerPage } from "@admin/platform/pages/monitor-server"
import { ForbiddenPage } from "@admin/platform/pages/forbidden"
import { PlaygroundQueryPage } from "@admin/platform/pages/playground-query"
import { PlaygroundTablePage } from "@admin/platform/pages/playground-table"
import { DevSandboxPage } from "@admin/platform/pages/dev-sandbox"
import { EmbeddedPage } from "@admin/platform/pages/embedded"
import { ProfilePage } from "@admin/platform/pages/profile"
import { NoticePage } from "@admin/platform/pages/notice"
import { PluginPage } from "@admin/platform/pages/plugin"
import { DashboardPage } from "@admin/platform/pages/dashboard"
import { SchedulerManagePage } from "@admin/platform/pages/scheduler-manage"
import { SchedulerRecordPage } from "@admin/platform/pages/scheduler-record"

/**
 * routeId → 页面组件。
 *
 * 隐藏的 tab 不是「当前匹配的路由」，拿不到 router 的 match 上下文，
 * 所以 TabOutlet 必须能自己解析出组件 —— 这张表就是解析依据。
 *
 * 硬纪律：这里注册的组件必须 router-独立，params/search 只能走 props。
 */
export const pageRegistry: PageRegistry = {
  "/_auth/403": ForbiddenPage,
  "/_auth/dashboard": DashboardPage,
  "/_auth/scheduler/manage": SchedulerManagePage,
  "/_auth/scheduler/record": SchedulerRecordPage,
  "/_auth/system/user": UserPage,
  "/_auth/system/role": RolePage,
  "/_auth/system/menu": MenuPage,
  "/_auth/system/dept": DeptPage,
  "/_auth/system/data-permission": DataPermissionPage,
  "/_auth/system/file": FilePage,
  "/_auth/log/login": LogLoginPage,
  "/_auth/log/opera": LogOperaPage,
  "/_auth/plugins/dict": DictPage,
  "/_auth/sandbox/table": PlaygroundTablePage,
  "/_auth/sandbox/query": PlaygroundQueryPage,
  "/_auth/sandbox/components": DevSandboxPage,
  "/_auth/embedded/$name": EmbeddedPage,
  "/_auth/plugins/config": ConfigPage,
  "/_auth/monitor/online": LogOnlinePage,
  "/_auth/monitor/redis": MonitorRedisPage,
  "/_auth/monitor/server": MonitorServerPage,
  "/_auth/profile": ProfilePage,
  "/_auth/plugins/notice": NoticePage,
  "/_auth/system/plugin": PluginPage,
}
