import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { formatDateTime } from '@admin/i18n'
import { Pagination } from '@admin/ui/components/pagination'
import { QueryError } from '@admin/ui/components/query-error'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Skeleton } from '@admin/ui/components/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { useTabPortalContainer } from '../../shell/tab-outlet'
import { RefreshButton } from '../_shared/filters'
import { noticeDetailQuery, noticeReadsQuery, type Notice } from './api'

export type ReadsTab = 'read' | 'unread'

/** 抽屉的视图状态 —— 全在 URL 里（硬纪律 2），由页面从 search 传进来 */
export type ReadsView = { tab: ReadsTab; page: number; size: number }

/**
 * 阅读统计（#190）：已读 / 未读两个页签 + 两边的人数 + 分页名单（`GET /sys/notices/{pk}/reads`）。
 *
 * - 「已读」= 收件箱那一行上有已读标记的人；「未读」= 发布范围内、启用的账号里还没读的。
 *   必须确认的公告，已读 = 点过「我已阅读」的人
 * - 还没有收件箱行（没到发布时间 / 隐藏 / 撤回了）两边都是 0 —— 那不是「全员未读」，是还没发到任何人手里，
 *   空态单独说清楚
 * - 有人读了不会推到这里（socket 只在发 / 撤公告时推），所以工具行有「刷新」
 *
 * 开着哪条、哪个页签、第几页都在 URL（`reads` / `rtab` / `rpage` / `rsize`），刷新回来还是这一页。
 * 🔴 开在 URL 上的抽屉 portal 要挂进本 tab 的根节点（`useTabPortalContainer`）：刷新后后台 tab 恢复出来，
 * 挂在 `<body>` 下就会压住前台页面（shell 分册）。
 */
export function NoticeReadsSheet({
  noticeId,
  row,
  view,
  onViewChange,
  onOpenChange,
}: {
  noticeId: string | null
  /** 从列表那一行点开的：标题直接用它，不用再取一次详情 */
  row: Notice | null
  view: ReadsView
  onViewChange: (next: Partial<ReadsView>) => void
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const container = useTabPortalContainer()
  // 关的时候调用方立刻把 id 清掉，抽屉还要播退场动画：留着上一个 id（同读者抽屉）
  const [lastId, setLastId] = React.useState(noticeId)
  if (noticeId !== null && noticeId !== lastId) setLastId(noticeId)
  const shownId = noticeId ?? lastId

  return (
    <Sheet open={noticeId !== null} onOpenChange={onOpenChange}>
      <SheetContent
        container={container}
        side="right"
        className="gap-0 data-[side=right]:sm:max-w-xl"
        data-testid="notice-reads"
      >
        {shownId ? (
          <ReadsBody id={shownId} row={row?.id === shownId ? row : null} view={view} onViewChange={onViewChange} />
        ) : (
          <SheetTitle className="sr-only">{t('阅读统计')}</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ReadsBody({
  id,
  row,
  view,
  onViewChange,
}: {
  id: string
  row: Notice | null
  view: ReadsView
  onViewChange: (next: Partial<ReadsView>) => void
}) {
  const { t } = useTranslation()
  const read = view.tab === 'read'
  const query = useQuery(noticeReadsQuery(id, { read, page: view.page, size: view.size }))
  // 从地址栏直接打开（刷新 / 分享的链接）时手上没有那一行，标题现取
  const detail = useQuery({ ...noticeDetailQuery(id), enabled: row === null })
  const title = row?.title ?? detail.data?.title

  const d = query.data
  const nothingSent = d !== undefined && d.read_count + d.unread_count === 0
  const rows = d?.items ?? []

  return (
    <>
      {/* pe-12：右上角是关闭按钮 */}
      <SheetHeader className="gap-1 border-b pe-12">
        <SheetTitle>{t('阅读统计')}</SheetTitle>
        <SheetDescription className="truncate" data-testid="notice-reads-title">
          {title ?? (detail.isPending && row === null ? '…' : '')}
        </SheetDescription>
      </SheetHeader>

      <div className="flex items-center gap-2 px-4 pt-3">
        <Tabs
          value={view.tab}
          // 换页签回第一页：两边的人数不一样，留着第 5 页多半是空页
          onValueChange={(v) => onViewChange({ tab: v as ReadsTab, page: 1 })}
        >
          <TabsList>
            <TabsTrigger value="read" data-testid="notice-reads-tab-read">
              {t('已读')}
              <span className="tabular-nums" data-testid="notice-reads-read-count">{d ? d.read_count : '–'}</span>
            </TabsTrigger>
            <TabsTrigger value="unread" data-testid="notice-reads-tab-unread">
              {t('未读')}
              <span className="tabular-nums" data-testid="notice-reads-unread-count">{d ? d.unread_count : '–'}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="ms-auto">
          <RefreshButton busy={query.isFetching} onClick={() => void query.refetch()} testId="notice-reads-refresh" />
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-4 py-3">
        {query.error && !d ? (
          // 硬纪律 9：失败不能长成「没有人读过」
          <QueryError error={query.error} onRetry={() => void query.refetch()} testId="notice-reads-error" />
        ) : query.isPending ? (
          <div className="flex flex-col gap-2" data-testid="notice-reads-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : nothingSent ? (
          <p className="py-10 text-center text-sm text-muted-foreground" data-testid="notice-reads-nothing-sent">
            {t('还没有发到任何人手里：没到发布时间、隐藏着，或者已经撤回 / 过期了。')}
          </p>
        ) : (
          <>
            {query.error && (
              <QueryError error={query.error} onRetry={() => void query.refetch()} testId="notice-reads-error" />
            )}
            <div className="rounded-md border" data-testid="notice-reads-table" data-fetching={query.isFetching}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('用户名')}</TableHead>
                    <TableHead>{t('昵称')}</TableHead>
                    <TableHead>{t('部门')}</TableHead>
                    {read && <TableHead>{t('阅读时间')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={read ? 4 : 3} className="py-8 text-center text-muted-foreground">
                        {read ? t('还没有人读过') : t('发布范围内的人都读过了')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => (
                      <TableRow key={r.user_id} data-testid="notice-reads-row" data-username={r.username}>
                        <TableCell className="font-mono text-xs">{r.username}</TableCell>
                        <TableCell>{r.nickname}</TableCell>
                        <TableCell className="text-muted-foreground">{r.dept_name ?? '—'}</TableCell>
                        {read && (
                          <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTime(r.read_time)}
                          </TableCell>
                        )}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            {d && d.total_pages > 1 && (
              <Pagination
                pageIndex={view.page - 1}
                pageCount={d.total_pages}
                pageSize={view.size}
                totalCount={d.total}
                onPageChange={(i) => onViewChange({ page: i + 1 })}
                onPageSizeChange={(s) => onViewChange({ size: s, page: 1 })}
                testIdPrefix="notice-reads"
              />
            )}
          </>
        )}
      </div>
    </>
  )
}
