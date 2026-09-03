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
 * ⚠️ **`dept_id` 的类型曾经是错的，现在不是了 —— 别再照着防。**
 * 原来 `common/schema.py` 只给 `id` 挂了 `@field_serializer('id') -> str | int`,
 * 外键（`dept_id` / `parent_id` / `role_id`…）声明成 `int`，而编码层的
 * `stringify_unsafe_ints` 照样把它们转成了字符串 —— 于是 `schema.d.ts` 里是
 * `number | null`、wire 上是字符串，按类型信它就会去 `Number()`（硬纪律 6）。
 * 修在后端标注上：`common/schema.py` 现在按**可空性分两组**挂了
 * `serialize_nullable_fk` / `serialize_required_fk`（不能一组全包，返回标注
 * 对列出的所有字段是同一份 —— 那边记着实测的两种错法），重新生成之后
 * `dept_id` 是 `string | number | null`。
 *
 * 🔴 **所以拿它当请求参数时仍然是 `string`，不要 `Number()`。** 联合类型只是
 * 说「声明终于不撒谎了」，不是说可以当数字用。
 * ⚠️ **请求体那一侧的声明还是 `integer`** —— pydantic 的校验 schema 和序列化
 * schema 是两份，`field_serializer` 只动后者。回传能用（FastAPI 会把 `"123"`
 * 强转），但声明不准。细节看 [`packages/api` 分册](../../../../packages/api/AGENTS.md)。
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
