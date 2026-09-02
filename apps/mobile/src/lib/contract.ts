import type { components } from '@admin/api/schema'

/**
 * 后端契约 —— **从生成的 `schema.d.ts` 派生，不再手抄**。
 *
 * 🔴 这份文件曾经是一整份**手抄本**（十几个 DTO、上百个字段）。它不会自己报错：
 * 字段名对不上只会在运行时变成 `undefined`，表现为界面上某一项空着、不报错。
 * 现在全部指向 `components['schemas'][...]`，后端改了契约 →
 * `pnpm --filter @admin/api gen:api` 重新生成 → **写错就是编译错误**。
 *
 * ⚠️ **剩下的三个别名只为「组件 props 要写类型」而存在**（`NotifRow` 收一条
 * `Notification`、`SessionProvider` 的 state 是 `CurrentUser | null`）。
 * 返回类型本身**不需要**别名 —— `api.GET('/api/v1/sys/users/me')` 是推断的。
 * 原来还有 `LoginResult` / `Captcha` / `PageData`，全部因为推断而变成了死代码
 * （是 eslint 抓出来的）。**不要为了「有个名字」再往这里加别名。**
 */
type S = components['schemas']

/**
 * `GET /api/v1/sys/users/me`。
 *
 * ⚠️ `dept` / `roles` 在这个 DTO 里被后端的 model_validator **摊平成名字**了
 * （`string` / `string[]`，不是对象）。要完整对象得走 `GET /sys/users/{pk}/roles`。
 *
 * 🔴 **注意 `dept_id` 的类型是错的（schema 说 `number | null`，wire 上是字符串）。**
 * 原因很具体：`common/schema.py` 只给 `id` 挂了
 * `@field_serializer('id') -> str | int`，所以只有 `id` 在 OpenAPI 里是联合类型；
 * 而**外键（`dept_id` / `parent_id` / `role_id`…）没有那个 serializer**，
 * 声明成 `int`，可编码层的 `stringify_unsafe_ints` 照样把它们转成了字符串
 * （`utils/serializers.py` 的注释里自己写着「外键都漏了」）。
 *
 * 移动端目前一处都没用到 `dept_id`，所以**不在这里覆盖** —— 覆盖一个类型
 * 就要维护一份「哪些字段的 schema 是错的」名单，而真正的修法在后端标注上。
 * 将来要用它做请求参数时先看 [`packages/api` 分册](../../../../packages/api/AGENTS.md)。
 */
export type CurrentUser = S['GetCurrentUserInfoWithRelationDetail']

/**
 * `GET /api/v1/sys/notifications` 的一条。
 *
 * 🔴 `read_time` **有值即已读**。它不是数据库列，是 service 在分页之后按
 * `sys_notification_read` 回填的 —— 别指望能用它做服务端筛选，
 * 筛未读要用 `?unread=true` 那个查询参数。
 *
 * ⚠️ `link` 是**前端路由**，那是 web 的路由；移动端没有对应页面，只展示不跳。
 */
export type Notification = S['GetNotificationDetail']

/** `GET /api/v1/sys/notifications/unread-count` */
export type NotificationUnread = S['GetNotificationUnreadDetail']

/**
 * 站内通知分类。数值来自后端的 `NotificationCategory` 枚举。
 *
 * ⚠️ 值是 **key**，不在这里 `t()` —— 模块级常量切语言不会变。
 */
export const NOTIFICATION_CATEGORY = {
  0: '系统',
  1: '公告',
  2: '任务',
} as const
