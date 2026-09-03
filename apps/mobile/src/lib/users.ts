import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/lib/api'

/**
 * 用户模块的取数 —— **移动端第一个「列表 → 详情 → 写操作」的范式样板。**
 *
 * 挑用户这个模块没有业务含义，挑的是它的**形状**：分页列表 + 查询参数 +
 * 详情 + 一个删除。字典、部门、公告要照抄的就是这一份。
 *
 * ## 🔴 路径参数里的雪花 ID 必须**原样传字符串**
 *
 * 这里有个反直觉的实测（在这个仓库里探过一次，结论钉在这儿）：
 *
 * | | 类型检查 | 实测 |
 * |---|---|---|
 * | **查询**参数名（`params.query`） | **严** | 写成 `usernamee` 是编译错误（`TS2561`，还会提示「Did you mean 'username'」） |
 * | **路径**参数（`params.path`） | **不检查** | schema 里写着 `pk: number`，传 `string` 或 `string \| number` **都不报错** |
 *
 * 所以这里**没有**编译器帮忙：
 *
 * - 一方面不会被 `pk: number` 那个声明逼着去写 `Number(id)` —— 那是硬纪律 6
 *   禁的事（`2049629108245233664` → `...233700`，连续几个 ID 还会塌成同一个）
 * - 另一方面**也没人挡着你写 `Number(id)`** —— 写了照样编译通过，然后静默
 *   删掉/打开另一条记录
 *
 * ⚠️ `pk: number` 这个声明本身是后端入参侧的标注问题（pydantic 的校验 schema
 * 和序列化 schema 是两份，`field_serializer` 只动后者），细节见
 * [`packages/api` 分册](../../../../packages/api/AGENTS.md)。**别在前端覆盖类型**
 * 绕过它 —— 那要维护一份「哪些声明是错的」名单。
 */

export type UserFilter = {
  /** 用户名模糊匹配。空串表示不筛 */
  username?: string
  /** 状态：`1` 启用 / `0` 停用 / `undefined` 不筛 */
  status?: number
}

/** 一页多少条。移动端一屏放不下十几张卡，20 条够翻两三屏 */
const PAGE_SIZE = 20

export const usersKey = {
  all: ['users'] as const,
  list: (filter: UserFilter) => ['users', 'list', filter] as const,
  detail: (id: string) => ['users', 'detail', id] as const,
}

/**
 * 分页列表。
 *
 * 🔴 **用 `useInfiniteQuery`，不是 `useQuery` + 一个大 `size`。**
 * 通知那一屏当初写的是 `size: 50` 一次拉完 + `ScrollView` + `map()` ——
 * 那个形状在几十条以内看不出问题，**下游照抄之后在第一个上千条的列表上就废了**
 * （首屏要等全量返回、内存里挂着上千个 View、滚动掉帧）。
 * 移动端的列表既然不能是表格（那是拍 C 路线的判据），它就**必须**是
 * 「一条条 + 翻到底继续拉」。
 *
 * ⚠️ **筛选条件进 query key**，不要塞进 `queryFn` 的闭包 —— 进 key 之后
 * 每套条件是**各自一份缓存**，切回去秒开，而且没有「后到的响应盖掉当前条件」
 * 那种竞态（通知屏为这条竞态修过一次）。
 */
export function useUsers(filter: UserFilter) {
  return useInfiniteQuery({
    queryKey: usersKey.list(filter),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.GET('/api/v1/sys/users', {
        params: {
          query: {
            page: pageParam,
            size: PAGE_SIZE,
            // 🔴 该省的参数传 `undefined`，**不要用条件展开**
            // （`...(x ? {a} : {})` 里的属性绕过 TS 的多余属性检查，
            // 参数名写错不报错，界面上像筛选没生效）。
            // openapi-fetch 的 querySerializer 会跳过 undefined
            username: filter.username?.trim() || undefined,
            status: filter.status,
          },
        },
      }),
    /**
     * 🔴 翻页的终点判据用 `page < total_pages`，**不要用 `items.length < size`**。
     * 后者在「最后一页刚好装满」时会多请求一次空页；FBA 的 `PageData` 直接
     * 给了 `total_pages`，用它就没有边界情况。
     */
    getNextPageParam: (last) => (last.page < last.total_pages ? last.page + 1 : undefined),
  })
}

/**
 * 详情。
 *
 * ⚠️ 它和列表用的是**同一个 DTO**（`GetUserInfoWithRelationDetail`），所以从
 * 列表点进来时其实已经有全部字段了。仍然单独请求一次，理由是：详情屏可能被
 * 深链直接打开（没有列表那份缓存），而「有时候请求有时候不请求」是更难维护的
 * 分支。要省这一次请求就用 `initialData` 从列表缓存里取，**不要**改成条件请求。
 */
export function useUser(id: string) {
  return useQuery({
    queryKey: usersKey.detail(id),
    // 🔴 `pk` 原样传字符串，见文件头注释。**不要 `Number(id)`**
    queryFn: () => api.GET('/api/v1/sys/users/{pk}', { params: { path: { pk: id } } }),
    enabled: id !== '',
  })
}

/**
 * 删除。
 *
 * 🔴 **这个接口在「删了 0 行」时返回 `HTTP 200 + code: 400`**
 * （`response_base.fail()`）。`@admin/api` 的 `resolveEnvelope` 会把它判成失败
 * 并抛 `ApiError`，所以这里**不需要**自己看 `code` —— 但要知道它会抛，
 * 别写成 `await mutate(); toast.success()` 那种「反正走到这儿就是成了」。
 *
 * ⚠️ 「删了 0 行」在三个方言下**不是同一件事**（根 `CLAUDE.md` 记着）：
 * MySQL 数受影响行，PostgreSQL / SQL Server 数匹配行。所以同一次
 * 「删一个不存在的 ID」在不同库上可能是 fail 也可能是 success ——
 * 不要把这个接口的返回当成「记录存在与否」的判据。
 */
export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    // 🔴 同上：字符串原样传
    mutationFn: (id: string) => api.DELETE('/api/v1/sys/users/{pk}', { params: { path: { pk: id } } }),
    onSuccess: async (_data, id) => {
      // 列表整棵失效（哪一页、哪套筛选条件都可能含这条），详情那份直接移除
      qc.removeQueries({ queryKey: usersKey.detail(id) })
      await qc.invalidateQueries({ queryKey: usersKey.all })
    },
  })
}
