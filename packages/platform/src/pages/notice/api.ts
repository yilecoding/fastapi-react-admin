import * as React from 'react'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { richTextFileIds } from '@admin/ui/components/rich-text'

import { ApiError } from '@admin/api'
import { toEpochMs, type ServerTime } from '@admin/i18n'

import { api, type PageData } from '../../api-client/client'
import { targetFilesQuery, useAttachFiles, useDetachFiles } from '../file/api'
import { NOTICE_FEED_KEY, invalidateInbox } from '../notification/api'

/**
 * 通知公告。
 *
 * ⚠️ 接口前缀是 **`/api/v1/sys/notices`**，不是 `plugin.toml` 里写的 `/notices` ——
 * 这个插件 `extend = "admin"`，路由被挂到了 admin 的 sys 下。参数配置踩过同一个坑。
 *
 * ⚠️ id 是雪花字符串，不要 `Number()`（CLAUDE.md 硬纪律 6）。
 *
 * 🔴 **「读」和「管」是两个口**（#186）：
 *
 * - `/sys/notices`、`/sys/notices/{pk}` 是**管理端**，要 `sys:notice:add`（和管理页的路由守卫同一个码）。
 *   原来它们只要登录，任何人都拿得到**隐藏的**公告和正文
 * - `/sys/notices/feed`、`/sys/notices/feed/{pk}` 是**读者**的口，只要登录：只给显示中、没过期的，
 *   隐藏 / 过期 / 删了的详情一律 404（刻意不分 —— 分开就等于告诉对方「这条存在，只是你看不了」）
 *
 * 工作台、铃铛、消息中心这些「所有人都会碰到」的地方**只能**用后一组，
 * 碰了前一组，普通用户那里就是一个 403 错误块。
 */
export type Notice = {
  id: string
  title: string
  /** 0 通知 · 1 公告 */
  type: number
  /** 0 隐藏 · 1 显示 */
  status: number
  content: string
  /** 置顶（读者列表里排在最前） */
  pinned: boolean
  /** 0 普通 · 1 重要 · 2 紧急，见 `NOTICE_LEVEL_LABEL` */
  level: number
  /** 过期时间；`null` = 不过期。过期之后读者看不到，管理页照样能看到 */
  expire_time: string | null
  /** 登录后弹窗（#190） */
  popup: boolean
  /** 必须点「我已阅读」—— 只在 `popup` 为真时有意义（后端：反过来 422） */
  require_ack: boolean
  /** 定时发布；`null` = 建好就发布。在未来 = 到点之前读者看不到、不进收件箱 */
  publish_time: string | null
  /** 登录页可见（不登录也能看）。和发布范围互斥（后端 422） */
  public: boolean
  /** 附件个数（管理列表上的 📎） */
  attachment_count: number
  /** 发布范围；空数组 = 全员。`name` 是显示名，对象删了是 `null` */
  audience: NoticeAudienceItem[]
  created_time: string
  updated_time: string | null
}

/** `backend/plugin/notification/enums.py: AudienceKind`。部门**含下级**（判定在看的人那一侧往上找） */
export type AudienceKind = 'dept' | 'role' | 'user'

/** 写入时的一项。`target_id` 是雪花字符串（硬纪律 6；后端按数字解析，不经过 JS number） */
export type NoticeAudienceEntry = { kind: AudienceKind; target_id: string }

export type NoticeAudienceItem = NoticeAudienceEntry & { name: string | null }

/**
 * 读者那一份（`/feed`）的一行。不带正文；带附件数和「我读没读」。
 *
 * `read` 跟着收件箱那一行走（`sys_notification_read`），不是另一张已读表 ——
 * 铃铛、消息中心、工作台看到的是同一份「读没读」。标已读也走收件箱那条接口，
 * 用的是 `notification_id`（没有收件箱行的老公告是 `null`，后端已经按「已读」下发）。
 */
export type NoticeFeedItem = {
  id: string
  title: string
  type: number
  pinned: boolean
  level: number
  expire_time: string | null
  popup: boolean
  /**
   * 必须点「我已阅读」。🔴 这种公告的 `read` **只认显式已读**（后端：新账号规则对它不生效），
   * 打开详情时也不能自动标已读 —— 自动标了，「必须确认」就等于没有
   */
  require_ack: boolean
  /** 定时发布的时间；`null` = 建好就发布了。界面上的「发布时间」一律 `publishedAt()` */
  publish_time: string | null
  created_time: string
  updated_time: string | null
  attachment_count: number
  /** ⚠️ openapi 里写的是 `number`，运行时是**字符串**（雪花 ID 由 `stringify_unsafe_ints` 转），按字符串用 */
  notification_id: string | null
  read: boolean
}

export type NoticeFeedDetail = NoticeFeedItem & { content: string }

/**
 * 读者看到的「发布时间」：定时发布的是到点那一刻，否则是建好那一刻。
 * 后端读者列表按同一个口径排序（`coalesce(publish_time, created_time)`）——
 * 一条一周前建好、今天才到点的公告，显示成一周前发的就和排序对不上了
 */
export function publishedAt(n: { publish_time: string | null; created_time: string }): string {
  return n.publish_time ?? n.created_time
}

/** 登录页上的一条（`GET /sys/notices/public`，**不用登录**）。只有纯文本摘要：不带正文、附件、图 */
export type PublicNotice = {
  id: string
  title: string
  level: number
  pinned: boolean
  /** 定时发布的时间；`null` = 建好就发布了。显示一律 `publishedAt()`（和读者看到的同一个时间） */
  publish_time: string | null
  created_time: string
  /** 正文去标签后的纯文本，最多 200 字 */
  summary: string
}

/** 阅读统计的一行（`GET /sys/notices/{pk}/reads`） */
export type NoticeReader = {
  user_id: string
  username: string
  nickname: string
  dept_name: string | null
  /** 已读页签有值；未读页签是 `null` */
  read_time: string | null
}

/**
 * 阅读统计的一页。分页的 `total` 是**当前页签**的条数；两个页签的人数另给，
 * 不管看哪个页签都一起回来（`total` 和分页撞名，所以没叫 `{read_count, total}`）
 */
export type NoticeReadsPage = PageData<NoticeReader> & { read_count: number; unread_count: number }

export type NoticeListParams = {
  page: number
  size: number
  title?: string
  type?: number
  status?: number
}

/**
 * 附件挂载用的 `target_type`。
 *
 * 后端**不校验**这个字符串（新业务挂附件不用改表也不用改后端），
 * 所以拼错不会报错、只会读到空列表 —— 必须走常量，不要在 JSX 里手敲字面量。
 */
export const NOTICE_ATTACHMENT_TARGET = 'NOTICE'

/**
 * 正文里**内联图**的 `target_type`，和附件分开。
 *
 * 为什么不共用 `NOTICE`：一篇公告正文里放十几张图是常事，全挤进详情抽屉的
 * 「附件」列表会把那个概念冲掉 —— 附件是「另外给你的文件」，内联图是正文的一部分。
 * `target_type` 后端不校验，所以多一个值不用改表也不用改后端。
 *
 * 它存在的唯一目的是**防孤儿**：不挂关联的话，公告删了之后这些图会永远留在
 * 磁盘和「文件管理」里，没人知道它们是谁的。
 */
export const NOTICE_CONTENT_TARGET = 'NOTICE_CONTENT'

export const noticeKeys = {
  all: ['sys', 'notice'] as const,
  list: (p: NoticeListParams) => [...noticeKeys.all, 'list', p] as const,
  /** 读者那一组的前缀：标已读之后整组失效（列表上的未读点、详情里的 `read`） */
  /** 定义在 `notification/api.ts`（收件箱一变它也要失效，那边要引用它；见 `invalidateInbox`） */
  feedAll: () => NOTICE_FEED_KEY,
  feed: (p: { page: number; size: number }) => [...noticeKeys.feedAll(), 'list', p] as const,
  feedDetail: (id: string) => [...noticeKeys.feedAll(), 'detail', id] as const,
  /**
   * 弹窗 / 横幅（#190）**挂在读者那组前缀下面**是刻意的：它们的条件里都有「我没读」，
   * 收件箱一变（标已读 / 全部已读 / socket 说发了新的或撤了）就得重取 ——
   * `invalidateInbox` 失效的正是这个前缀，不用再单独接一遍
   */
  popups: () => [...noticeKeys.feedAll(), 'popups'] as const,
  banner: () => [...noticeKeys.feedAll(), 'banner'] as const,
  /** 登录页那份不挂在 feed 下：没登录、没有「我」，和收件箱无关 */
  publicList: () => [...noticeKeys.all, 'public'] as const,
  detail: (id: string) => [...noticeKeys.all, 'detail', id] as const,
  reads: (id: string, p: { read: boolean; page: number; size: number }) =>
    [...noticeKeys.all, 'reads', id, p] as const,
}

function qs(p: NoticeListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.title) s.set('title', p.title)
  if (p.type !== undefined) s.set('type', String(p.type))
  if (p.status !== undefined) s.set('status', String(p.status))
  return s.toString()
}

export const noticesQuery = (p: NoticeListParams) =>
  queryOptions({
    queryKey: noticeKeys.list(p),
    queryFn: () => api.GET<PageData<Notice>>(`/api/v1/sys/notices?${qs(p)}`),
    // 翻页时保留上一页，避免表格闪空
    placeholderData: (prev) => prev,
  })

/** 读者列表：显示中、没过期的，置顶在前、再按时间倒序（排序在后端） */
export const noticeFeedQuery = (p: { page: number; size: number }) =>
  queryOptions({
    queryKey: noticeKeys.feed(p),
    queryFn: () => api.GET<PageData<NoticeFeedItem>>(`/api/v1/sys/notices/feed?page=${p.page}&size=${p.size}`),
  })

/** 404 = 撤回了 / 过期了 / 删了（后端刻意不分）。这是一个**结论**，重试也不会变 */
export function isNoticeGone(e: unknown): boolean {
  return e instanceof ApiError && e.httpStatus === 404
}

export const noticeFeedDetailQuery = (id: string) =>
  queryOptions({
    queryKey: noticeKeys.feedDetail(id),
    queryFn: () => api.GET<NoticeFeedDetail>(`/api/v1/sys/notices/feed/${id}`),
    // 全局是 `retry: 1`：404 再试一次只是让「已撤回」晚一秒出来；别的错误照旧重试一次
    retry: (count, e) => !isNoticeGone(e) && count < 1,
  })

/**
 * 登录后要弹给我的公告（#190）：看得见 · 弹窗 · 我没读（必须确认的只认点过「我已阅读」）。
 * 置顶 → 级别 → 新到旧，最多 10 条，**带正文**（弹窗里直接显示，不再一条条取详情）。
 *
 * 「拉一次」靠的是 `staleTime: Infinity`：它只在收件箱变了的时候重取（`invalidateInbox` 失效整个
 * feed 前缀 —— 铃铛收到 socket `notification:new` 时调的就是它，在线的人当场弹出新发的必读公告）。
 * 不能跟着全局 30 秒 `staleTime` 走：切个 tab 就重取一次是纯噪音，正文还不小
 */
export const noticePopupsQuery = queryOptions({
  queryKey: noticeKeys.popups(),
  queryFn: () => api.GET<NoticeFeedDetail[]>('/api/v1/sys/notices/feed/popups'),
  staleTime: Infinity,
})

/** 顶部横幅：看得见 · 置顶 · 紧急 · 我没读，最多 3 条，不带正文。刷新时机同上 */
export const noticeBannerQuery = queryOptions({
  queryKey: noticeKeys.banner(),
  queryFn: () => api.GET<NoticeFeedItem[]>('/api/v1/sys/notices/feed/banner'),
  staleTime: Infinity,
})

/**
 * 登录页公告（**不用登录**，每 IP 每分钟 30 次）。
 *
 * `retry: false`：失败了界面上有「重试」，自动再试一次只会多吃一次限流配额 ——
 * 命中 429 时更是把自己往限流里推
 */
export const publicNoticesQuery = queryOptions({
  queryKey: noticeKeys.publicList(),
  queryFn: () => api.GET<PublicNotice[]>('/api/v1/sys/notices/public'),
  staleTime: 5 * 60_000,
  retry: false,
})

/** 管理端详情（要 `sys:notice:add`）。阅读统计抽屉从地址栏直接打开时，标题靠它 */
export const noticeDetailQuery = (id: string) =>
  queryOptions({
    queryKey: noticeKeys.detail(id),
    queryFn: () => api.GET<Notice>(`/api/v1/sys/notices/${id}`),
  })

/** 阅读统计。`read=true` 已读的、`false` 发布范围内还没读的（启用的账号） */
export const noticeReadsQuery = (id: string, p: { read: boolean; page: number; size: number }) =>
  queryOptions({
    queryKey: noticeKeys.reads(id, p),
    queryFn: () =>
      api.GET<NoticeReadsPage>(`/api/v1/sys/notices/${id}/reads?read=${p.read}&page=${p.page}&size=${p.size}`),
    // 翻页 / 换页签时保留上一份，计数和表格不闪空
    placeholderData: (prev) => prev,
  })

/**
 * 标已读。走收件箱那条接口（读没读只有那一份），成功后两边一起失效：
 * 铃铛 / 消息中心的未读数，和工作台卡片上的未读点（还有弹窗 / 横幅，它们在同一个前缀下）。
 * 少失效一边就是「铃铛红点没了、工作台那一行还挂着未读点」（或者反过来）。
 *
 * 「我已阅读」/ 关横幅 / 看过弹窗都走它 —— 后端没有另一个「确认」接口，显式的已读行就是确认。
 * 调用处自己把错误画在按钮旁边的，传 `suppressErrorToast`（不然同一个错误弹两遍）
 */
export function useMarkNoticeRead(opts: { suppressErrorToast?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: opts.suppressErrorToast ?? false },
    mutationFn: (notificationId: string) => api.PUT<null>(`/api/v1/sys/notifications/${notificationId}/read`),
    onSuccess: () => invalidateInbox(qc),
    // 404 = 那一行已经撤回 / 看不见了（`isNoticeGone`）：手上的弹窗 / 横幅 / 详情都是旧的，一起重取
    onError: (e) => {
      if (isNoticeGone(e)) void invalidateInbox(qc)
    },
  })
}

/** 过期了没有。比较一律走 epoch（i18n 分册：不拿时间字符串比大小） */
export function isExpired(expireTime: ServerTime, now = Date.now()): boolean {
  const ms = toEpochMs(expireTime)
  return ms !== null && ms <= now
}

/** 定时发布、还没到点（#190）：读者看不到、不进收件箱。同上走 epoch */
export function isScheduled(publishTime: ServerTime, now = Date.now()): boolean {
  const ms = toEpochMs(publishTime)
  return ms !== null && ms > now
}

export type NoticeBody = {
  title: string
  type: number
  status: number
  content: string
  pinned: boolean
  level: number
  /** 带偏移的 ISO；`null` = 不过期 */
  expire_time: string | null
  popup: boolean
  require_ack: boolean
  /** 带偏移的 ISO；`null` = 立即发布 */
  publish_time: string | null
  public: boolean
  /**
   * 发布范围，语义和 `attachment_ids` 同一套：
   *
   * - 不传（`undefined`）= 不改。🔴 **编辑时没动过范围就别发**：范围里点过的人 / 部门后来被删了的话，
   *   原样发回去后端会按「范围里有不存在的对象」整条 400 —— 改个标题都存不上
   * - `[]` = 全员。⚠️ 所以「指定范围」一个都没选时**不能**发 `[]`，那是把范围悄悄放大成全员（表单里拦）
   */
  audience?: NoticeAudienceEntry[]
  /**
   * 附件文件 ID，**按顺序**（读者那边就按这个顺序列）。
   *
   * - 不传（`undefined`）= 附件不动 —— 编辑时附件列表还没取回来就提交，绝不能当成「清空」发出去
   * - `[]` = 全部摘掉
   *
   * 后端和公告**同一个事务**里挂附件、再发广播（读者收到通知时附件已经在了）；
   * 文件是公开的 / 自己读不了的，整条 400 回滚
   */
  attachment_ids?: string[]
}

/**
 * 新建。**返回创建出来的公告**（含 id）——
 * 保存后要拿这个 id 把正文里的内联图挂到 `sys_file_relation` 上。
 */
export function useCreateNotice() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (body: NoticeBody) => api.POST<Notice>('/api/v1/sys/notices', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: noticeKeys.all }),
  })
}

/**
 * 把正文里引用的图片与 `sys_file_relation` 对齐。
 *
 * 正文存的是 `<img src="/uploads/…" data-file-id="220…">`：`src` 用来渲染、
 * `data-file-id` 用来做这件事。两边 diff —— 正文里新出现的挂上、被删掉的卸下。
 *
 * 三个要点：
 *
 * - **挂载是幂等的**（后端跳过已挂的），所以重复保存不会挂出重复行，
 *   `attach` 返回 0 是成功不是失败
 * - **「卸下」只删关联、不删文件** —— 那张图仍在「文件管理」里。正文里删掉一张图
 *   不该顺手把文件也毁掉（别处可能还引用着）。代价是会攒下「传了又删」的文件，
 *   那属于文件管理页的清理工作
 * - **失败不能挡住保存**：公告正文已经存进库了，关联只是运维用的账。
 *   在这里往上抛会让用户看到「保存失败」然后再存一次 —— 而正文其实已经存进去了
 */
export function useSyncNoticeImages() {
  const attach = useAttachFiles()
  const detach = useDetachFiles()
  const qc = useQueryClient()

  return React.useCallback(
    async (noticeId: string, content: string) => {
      const wanted = new Set(richTextFileIds(content))
      let current: string[] = []
      try {
        // 走 fetchQuery 而不是 useQuery：这是提交那一刻的一次性读取，
        // 不该让表单去订阅一个只在提交时有用的查询
        const files = await qc.fetchQuery(targetFilesQuery(NOTICE_CONTENT_TARGET, noticeId))
        current = files.map((f) => f.id)
      } catch {
        // 读不到就当没有已挂的：attach 幂等，最坏情况是这次少卸掉几条关联
      }

      const toAttach = Array.from(wanted).filter((id) => !current.includes(id))
      const toDetach = current.filter((id) => !wanted.has(id))

      try {
        if (toAttach.length) {
          await attach.mutateAsync({
            file_ids: toAttach,
            target_type: NOTICE_CONTENT_TARGET,
            target_id: noticeId,
          })
        }
        if (toDetach.length) {
          await detach.mutateAsync({
            file_ids: toDetach,
            target_type: NOTICE_CONTENT_TARGET,
            target_id: noticeId,
          })
        }
      } catch (e) {
        // 见上面第三点：只记一条，不往上抛
        console.warn('[notice] 内联图关联同步失败，正文已保存', e)
      }
    },
    [attach, detach, qc]
  )
}

export function useUpdateNotice() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, body }: { id: string; body: NoticeBody }) =>
      api.PUT(`/api/v1/sys/notices/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: noticeKeys.all }),
  })
}

/**
 * 删除（单条与批量同一个接口）。
 *
 * 后端 `DELETE /sys/notices` 直接收 `{pks: []}`，是**真批量**，
 * 不像用户那边只有单条接口要前端并发发 N 个请求。
 */
/**
 * 单条删除和批量删除共用同一个接口，但错误处理策略不同：单条删除留在弹窗里
 * 原地重试（流派一），批量删除是 `allSettled` 的部分失败语义，重试整个选中集合
 * 没有意义，照旧关弹窗走全局 toast——所以 `suppressErrorToast` 按调用方传，
 * 两处各自 `useDeleteNotices()` 一份互不影响的 mutation 实例。
 */
export function useDeleteNotices(opts: { suppressErrorToast?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: opts.suppressErrorToast ?? false },
    mutationFn: (pks: string[]) => api.DELETE('/api/v1/sys/notices', { body: { pks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: noticeKeys.all }),
  })
}

// ─── 展示用的枚举映射 ────────────────────────────────────────────────────────

/** `backend/plugin/notice/enums.py: NoticeType` */
// 三张表的值都是**语言包 key**（中文原文即 key）——
// 渲染处过 t()：columns/detail-sheet 用 t(NOTICE_TYPE_LABEL[…])，
// SelectFilter / 表单 Select 在组件内部对 items 逐个 t()。
export const NOTICE_TYPE_LABEL: Record<number, string> = { 0: '通知', 1: '公告' }
export const NOTICE_TYPE_FILTER_ITEMS: Record<string, string> = {
  all: '全部类型', '0': '通知', '1': '公告',
}
export const NOTICE_TYPE_FORM_ITEMS: Record<string, string> = { '0': '通知', '1': '公告' }

/**
 * 状态在这一页的语义是**显示 / 隐藏**，不是系统通用的正常 / 停用
 * （`sys_notice.status` 注释：0 隐藏、1 显示），所以不能直接用
 * `_shared/status.tsx` 的 `StatusBadge` —— 那个写死了「正常 / 停用」。
 */
export const NOTICE_STATUS_FILTER_ITEMS: Record<string, string> = {
  all: '全部状态', '1': '显示', '0': '隐藏',
}
export const NOTICE_STATUS_FORM_ITEMS: Record<string, string> = { '1': '显示', '0': '隐藏' }

/** `backend/plugin/notice/enums.py: NoticeLevel`。数值是契约，改数字要两边一起改 */
export const NOTICE_LEVEL = { NORMAL: 0, IMPORTANT: 1, URGENT: 2 } as const
export const NOTICE_LEVEL_LABEL: Record<number, string> = { 0: '普通', 1: '重要', 2: '紧急' }
export const NOTICE_LEVEL_FORM_ITEMS: Record<string, string> = { '0': '普通', '1': '重要', '2': '紧急' }

/** 每条公告最多几个附件 —— 后端 `NOTICE_ATTACHMENT_MAX`（`plugin/notice/schema/notice.py`），超了 422 */
export const NOTICE_ATTACHMENT_MAX = 20
