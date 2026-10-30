import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@admin/api'

import { api } from '@/lib/api'
import type { NoticeFeedDetail } from '@/lib/contract'

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
  /** 首页那几条（所有 size 共一层前缀，标已读后整层失效） */
  feeds: ['notices', 'feed'] as const,
  feed: (size: number) => ['notices', 'feed', size] as const,
  detail: (id: string) => ['notices', 'detail', id] as const,
  attachments: (id: string) => ['notices', 'attachments', id] as const,
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

/** 首页：最近几条（置顶在前） */
export function useNoticeFeed(size: number) {
  return useQuery({
    queryKey: noticesKey.feed(size),
    queryFn: () => api.GET('/api/v1/sys/notices/feed', { params: { query: { page: 1, size } } }),
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
 * 标已读（打开详情成功之后调一次）。
 *
 * 失败**不报**：已读是顺手的副作用，读者此刻在看正文，为它弹一条错误只会打扰；
 * 下次进来 `read` 还是 false，会再标一次（接口幂等）。
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
      // 首页的未读圆点、通知屏的列表 + 未读数（tab 红点）都跟着这一行
      await Promise.all([
        qc.invalidateQueries({ queryKey: noticesKey.feeds }),
        qc.invalidateQueries({ queryKey: ['notifications'] }),
      ])
    },
  })
}
