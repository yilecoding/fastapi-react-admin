/**
 * `/api/v1/sys/menus/sidebar` 的手写类型。
 *
 * 后端签名是 `ResponseSchemaModel[list[dict[str, Any] | None]]` —— 无结构化 schema，
 * openapi-typescript 生不出来，所以这个文件是**手工维护**的。
 * 后端改 `backend/utils/build_tree.py: get_vben5_tree_data()` 时必须同步这里。
 *
 * 样本见 apps/api/contracts/sidebar.sample.json（实测抓取，非推测）。
 */

/** 0 目录 · 1 菜单 · 2 按钮 · 3 内嵌 · 4 外链 */
export const MenuType = {
  Directory: 0,
  Menu: 1,
  Button: 2,
  Iframe: 3,
  Link: 4,
} as const
export type MenuType = (typeof MenuType)[keyof typeof MenuType]

export type SidebarMeta = {
  /** ⚠️ 是 i18n key（如 "page.menu.sysUser"），不是显示文本 —— 见 icon-registry / title 解析 */
  title: string
  /** ⚠️ Iconify 命名（如 "ant-design:user-outlined"），不是 Tabler 名 */
  icon: string | null
  /** type=3 内嵌时的 iframe 地址，否则空串 */
  iframeSrc: string
  /** type=4 外链时的地址，否则空串 */
  link: string
  hideInMenu: boolean
  menuVisibleWithForbidden: boolean
}

export type SidebarNode = {
  /**
   * ⚠️ 是**字符串**不是数字。
   * 雪花 ID 约 2^61，超出 JS 的 Number.MAX_SAFE_INTEGER (2^53-1)，
   * 当数字解析会静默丢精度并相互碰撞（实测连续 6 个菜单 ID 塌缩成同一值）。
   * 后端 `utils/build_tree.py: stringify_big_ids()` 负责转成字符串下发。
   */
  id: string
  /** 路由 name，全局唯一 */
  name: string
  /** 路由地址；按钮类(type=2)不会出现在侧边栏树里 */
  path: string | null
  sort: number
  type: MenuType
  /** 权限标识，如 "sys:user:add" */
  perms: string | null
  remark: string | null
  parent_id: string | null
  created_time: string
  updated_time: string | null
  deleted: number
  deleted_time: string | null
  meta: SidebarMeta
  children?: SidebarNode[]
}

/** FBA 统一响应包封 */
export type FbaResponse<T> = { code: number; msg: string; data: T }
export type SidebarResponse = FbaResponse<SidebarNode[]>
/** `/api/v1/auth/codes` —— 权限码数组 */
export type CodesResponse = FbaResponse<string[]>
