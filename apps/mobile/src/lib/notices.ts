import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@admin/api'

import { api } from '@/lib/api'
import type { NoticeFeedDetail } from '@/lib/contract'
import { useServer } from '@/lib/server'
import { useSession } from '@/lib/session'

/**
 * 公告（读者那一侧，#186）—— 首页的「公告」组 + 详情屏 + 附件。
 *
 * 走的是 `GET /sys/notices/feed*`（只要登录），**不是**管理端的 `GET /sys/notices`：
 * 后者要 `sys:notice:add`，普通员工拿到的是 403（`plugin/notice` 分册「读和管是两个口」）。
 * feed 只给「显示 + 没过期」的，置顶在前、再按新到旧。
 *
 * ⚠️ 已读状态**跟着收件箱那一行走**（`notification_id`），不另建已读表 ——
 * 首页的未读圆点、通知屏的未读、铃铛的红点是同一份。所以标已读走的是
 * `PUT /sys/notifications/{pk}/read`，标完要把三处一起失效。
 */

export const noticesKey = {
  all: ['notices'] as const,
  /**
   * 读者那一侧的列表：首页那几条 · 弹窗 · 横幅（#190）。标已读后**整层**失效 ——
   * 🔴 弹窗和横幅的条件里都有「我没读」，所以刻意挂在这一层前缀下：在详情屏点过「我已阅读」、
   * 或者在通知屏读过的那条，不跟着失效的话下次回前台还会再弹一次
   */
  feeds: ['notices', 'feed'] as const,
  feed: (size: number) => ['notices', 'feed', size] as const,
  popups: ['notices', 'feed', 'popups'] as const,
  banner: ['notices', 'feed', 'banner'] as const,
  /**
   * 登录页（匿名）。🔴 **key 里带服务器地址**：地址能在运行时改（`serverStore`），
   * 不带的话换了服务器之后 30 秒内显示的还是上一台的公告（缓存在 `staleTime` 里算新鲜）
   */
  public: (base: string) => ['notices', 'public', base] as const,
  detail: (id: string) => ['notices', 'detail', id] as const,
  attachments: (id: string) => ['notices', 'attachments', id] as const,
}

/**
 * 界面上显示的「发布时间」：定时发布的用 `publish_time`，否则是建好就发了（`created_time`）。
 * 和 feed 的排序口径一致（后端按 `coalesce(publish_time, created_time)` 排）——
 * 一条一周前建好、今天才到点的公告，显示「一周前」会让人以为它早就发了
 */
export function noticePublishedAt(n: { publish_time?: string | null; created_time: string }): string {
  return n.publish_time ?? n.created_time
}

/** 附件挂在 `sys_file_relation` 上的业务类型。和 web 的 `NOTICE_ATTACHMENT_TARGET` 同值 */
export const NOTICE_ATTACHMENT_TARGET = 'NOTICE'

/**
 * 级别 → 徽标文案。`0`（普通）不出徽标。
 *
 * ⚠️ 值是 **key**，由使用处 `t()`（模块级常量切语言不会变）。
 */
export const NOTICE_LEVEL_LABEL: Record<number, string | undefined> = {
  1: '重要',
  2: '紧急',
}

/**
 * 收件箱一行的 `source` → 公告 ID。不是公告来的返回 `null`。
 *
 * 🔴 **ID 原样当字符串用，不要 `Number()`**（硬纪律 6）—— 雪花 ID 超过
 * `MAX_SAFE_INTEGER`，转一下就指向另一条公告。
 */
export function noticeIdFromSource(source: string | null | undefined): string | null {
  const m = /^notice:(\d+)$/.exec(source ?? '')
  return m?.[1] ?? null
}

/**
 * 标已读撞上 404 = 收件箱那一行已经看不见了（公告被撤回 / 隐藏 / 过期，或者发布范围不再包括这个人）。
 * 那时候没有东西可标，**不是失败**：弹窗、横幅收起就是了，不该报「没能标为已读」——
 * 更不能让必须确认的弹窗因为它卡住（「我已阅读」是唯一的出口，它永远 404 就永远关不掉）
 */
export function isNoticeGone(err: unknown): boolean {
  return err instanceof ApiError && err.httpStatus === 404
}

/** 首页：最近几条（置顶在前） */
export function useNoticeFeed(size: number) {
  return useQuery({
    queryKey: noticesKey.feed(size),
    queryFn: () => api.GET('/api/v1/sys/notices/feed', { params: { query: { page: 1, size } } }),
  })
}

/**
 * 登录后弹窗（#190）：看得见 · `popup` · 我没读，最多 10 条，**带正文**。
 *
 * 🔴 **移动端没有 socket**（`lib/notifications.tsx` 头注释），web 收到 `notification:new` 就重拉，
 * 这里靠的是「回到前台」：`lib/query.tsx` 把 `AppState` 接到了 `focusManager`，
 * 默认的 `refetchOnWindowFocus` + `staleTime` 30 秒 —— 离开超过 30 秒再回来就重拉一次。
 * 弹窗宿主在已登录那棵树里一直挂着（`(app)/_layout.tsx`），所以这个查询一直有观察者，回前台一定会重拉。
 * ⚠️ 刻意不把 `staleTime` 压成 0：iOS 拉一下通知中心也是一次 inactive → active，压成 0 就是每拉一下打一次
 *
 * `enabled` 跟着会话走（同 `useUnread`）：登出那一瞬间这棵树还没卸载，
 * 不拦的话会拿一个已经清掉的 token 再打一次
 */
export function useNoticePopups() {
  const { status } = useSession()
  return useQuery({
    queryKey: noticesKey.popups,
    queryFn: () => api.GET('/api/v1/sys/notices/feed/popups'),
    enabled: status === 'authed',
  })
}

/** 首页横幅（#190）：看得见 · 置顶 · 紧急 · 我没读，最多 3 条，不带正文 */
export function useNoticeBanner() {
  const { status } = useSession()
  return useQuery({
    queryKey: noticesKey.banner,
    queryFn: () => api.GET('/api/v1/sys/notices/feed/banner'),
    enabled: status === 'authed',
  })
}

/**
 * 登录页的公告（#190）：**不用登录**，最多 5 条纯文本摘要。
 *
 * - 🔴 key 里带**当前**服务器地址（`useServer()` 订阅了 `serverStore`）：请求本身每次现取地址
 *   （`lib/api.ts`），但缓存是按 key 认的 —— 不带地址的话，换了服务器之后先显示的是上一台的公告
 * - 不会引出刷新那一套：登录屏上通常没有 token（`sentWithToken` 为假时 401 不刷新，`packages/api` 分册）；
 *   就算 SecureStore 里还留着一个（启动时「连不上」那条路不清 token），后端对这条路径**不解析**
 *   Authorization（`TOKEN_REQUEST_PATH_EXCLUDE` 精确匹配，`jwt_auth_middleware.extract_token` 直接返回 None），
 *   一个过期 token 也换不来 401
 * - 限流（每 IP 每分钟 30 次）撞上是 429，`lib/query.tsx` 对 429 不重试
 */
export function usePublicNotices() {
  const { base } = useServer()
  return useQuery({
    queryKey: noticesKey.public(base),
    queryFn: () => api.GET('/api/v1/sys/notices/public'),
  })
}

/**
 * 详情（带正文）。
 *
 * 🔴 **404 不重试。** 隐藏 / 过期 / 删除的公告一律 404（后端刻意不区分，403 等于告诉
 * 对方「这条存在」）。默认的重试策略会对它再打两次，「已撤回」那一屏要多等三四秒才出来，
 * 而重试**不可能**成功。
 */
export function useNoticeDetail(id: string) {
  return useQuery({
    queryKey: noticesKey.detail(id),
    // 🔴 `pk` 原样传字符串（路径参数不做类型检查，见 `lib/users.ts` 头注释）
    queryFn: () => api.GET('/api/v1/sys/notices/feed/{pk}', { params: { path: { pk: id } } }),
    enabled: id !== '',
    retry: (count, error) => !(error instanceof ApiError && error.httpStatus === 404) && count < 2,
  })
}

/**
 * 附件列表。只在详情说「有附件」时才拉（`attachment_count > 0`）。
 *
 * ⚠️ 返回的是**这个人读得了的**那些（后端按 `can_read` 过滤过），所以个数可能比
 * `attachment_count` 少 —— 界面以这份列表为准。
 */
export function useNoticeAttachments(id: string, enabled: boolean) {
  return useQuery({
    queryKey: noticesKey.attachments(id),
    queryFn: () =>
      api.GET('/api/v1/sys/files/targets/{target_type}/{target_id}', {
        params: { path: { target_type: NOTICE_ATTACHMENT_TARGET, target_id: id } },
      }),
    enabled: enabled && id !== '',
  })
}

/**
 * 标已读。四个调用点，报不报错由调用点定：
 *
 * | 调用点 | 失败了 |
 * |---|---|
 * | 详情屏打开成功后**自动**标（不必确认的） | **不报**：已读是顺手的副作用，读者此刻在看正文，为它弹一条错误只会打扰；下次进来 `read` 还是 false，会再标一次（接口幂等） |
 * | 详情屏 / 弹窗的「我已阅读」（`require_ack`，#190） | 报：这是读者**主动**做的确认，没记下来必须让他知道 |
 * | 弹窗的「知道了」· 横幅的 ✕（#190） | 报（toast）：弹窗 / 横幅已经收起了，不说的话下次回前台它又出现，像是没点上 |
 *
 * 🔴 `require_ack` 的公告**只认显式已读**（后端 `unread_clause(explicit_only=…)`），所以它不能被任何「顺手」
 * 的路径标掉 —— 详情屏的自动标、通知屏点一行都要绕开它（各自的注释里写着）
 */
export function useMarkNoticeRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { noticeId: string; notificationId: string | number }) =>
      // 🔴 `notification_id` 在 schema 里声明成 `number`，wire 上却是字符串（雪花 ID 超出
      // 安全整数，编码层 `stringify_unsafe_ints` 转了串）—— 原样传，绝对不要 `Number()`
      api.PUT('/api/v1/sys/notifications/{pk}/read', { params: { path: { pk: v.notificationId } } }),
    onSuccess: (_data, v) => {
      // 详情那份直接改成已读，不为它再打一次请求
      qc.setQueryData(noticesKey.detail(v.noticeId), (prev: NoticeFeedDetail | undefined) =>
        prev ? { ...prev, read: true } : prev,
      )
    },
    onSettled: async () => {
      // 首页的未读圆点 · 弹窗 · 横幅（都在 `feeds` 这层前缀下）、通知屏的列表 + 未读数（tab 红点）都跟着这一行
      await Promise.all([
        qc.invalidateQueries({ queryKey: noticesKey.feeds }),
        qc.invalidateQueries({ queryKey: ['notifications'] }),
      ])
    },
  })
}
