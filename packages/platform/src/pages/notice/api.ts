import * as React from 'react'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { richTextFileIds } from '@admin/ui/components/rich-text'

import { api, type PageData } from '../../api-client/client'
import { targetFilesQuery, useAttachFiles, useDetachFiles } from '../file/api'

/**
 * 通知公告。
 *
 * ⚠️ 接口前缀是 **`/api/v1/sys/notices`**，不是 `plugin.toml` 里写的 `/notices` ——
 * 这个插件 `extend = "admin"`，路由被挂到了 admin 的 sys 下。参数配置踩过同一个坑。
 *
 * ⚠️ id 是雪花字符串，不要 `Number()`（CLAUDE.md 硬纪律 6）。
 */
export type Notice = {
  id: string
  title: string
  /** 0 通知 · 1 公告 */
  type: number
  /** 0 隐藏 · 1 显示 */
  status: number
  content: string
  created_time: string
  updated_time: string | null
}

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

export type NoticeBody = {
  title: string
  type: number
  status: number
  content: string
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
