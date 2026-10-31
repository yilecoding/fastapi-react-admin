import * as React from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { IconChevronDown, IconSpeakerphone } from "@tabler/icons-react"

import { formatDateTimeShort } from "@admin/i18n"
import { publicNoticesQuery, publishedAt, type PublicNotice } from "@admin/platform/pages/notice/api"
import { NoticeLevelPill, PinnedMark } from "@admin/platform/pages/notice/shared"
import { cn } from "@admin/ui/lib/utils"

/** 摘要超过这个长度才给「展开」：两行放得下的，没东西可展开，按钮只是噪音（400px 宽的栏 ≈ 两行中文） */
const EXPANDABLE_FROM = 56

/**
 * 登录页的公告（#190，`GET /sys/notices/public`，**不用登录**）。只有标题 + 级别 + 纯文本摘要 ——
 * 正文、附件、图都不出去（后端只给 200 字摘要）。
 *
 * 三种状态，**哪一种都不能挡住登录**：
 *
 * - 取数中 / 一条都没有：整块不画（不留一个空标题，也不画骨架 —— 骨架消失时表单会跳一下）
 * - 失败：一行很轻的「公告加载失败 · 重试」。不画成红色错误块 —— 这里的主角是登录表单，
 *   公告取不到不影响登录；但也不能什么都不画（硬纪律 9：那和「没有公告」分不出来）
 * - 有：一个小列表，摘要两行截断，长的可以展开
 *
 * 桌面端用的是同一个登录页（跑在 `app://local` 下，对后端是跨站请求）：这个接口不带凭据、不认 cookie，
 * 走的是和验证码一样的匿名请求，不受桌面端那条 refresh cookie 的限制。
 */
export function PublicNotices({ className }: { className?: string }) {
  const { t } = useTranslation()
  const query = useQuery(publicNoticesQuery)

  if (query.error) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)} data-testid="public-notices-error">
        {t("公告加载失败")}
        <span aria-hidden> · </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="text-primary underline-offset-2 hover:underline disabled:opacity-60"
          data-testid="public-notices-retry"
        >
          {t("重试")}
        </button>
      </p>
    )
  }

  const items = query.data ?? []
  if (items.length === 0) return null

  return (
    <section className={className} aria-labelledby="public-notices-title" data-testid="public-notices">
      <h2
        id="public-notices-title"
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <IconSpeakerphone className="size-3.5" aria-hidden />
        {t("公告")}
      </h2>
      <ul className="mt-2 flex flex-col divide-y divide-border/60">
        {items.map((n) => (
          <PublicNoticeItem key={n.id} notice={n} />
        ))}
      </ul>
    </section>
  )
}

function PublicNoticeItem({ notice: n }: { notice: PublicNotice }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const expandable = n.summary.length > EXPANDABLE_FROM
  const summaryId = React.useId()

  return (
    <li className="py-2" data-testid="public-notice" data-notice-id={n.id}>
      <div className="flex items-center gap-1.5 text-sm">
        {n.pinned && <PinnedMark />}
        <NoticeLevelPill level={n.level} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="public-notice-title">
          {n.title}
        </span>
        {/* 没登录，没有显示时区偏好 —— 按浏览器时区印（`formatDateTimeShort` 的默认）。
            时间用 `publishedAt`（定时发布的按发布时间）：只印 created_time 的话，一条昨天建好、
            今天才到点的公告，登录页上写着昨天，而登录进去读者看到的是今天 */}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {formatDateTimeShort(publishedAt(n))}
        </span>
      </div>
      {n.summary && (
        <p
          id={summaryId}
          className={cn("mt-1 text-xs leading-relaxed whitespace-pre-line text-muted-foreground", !open && "line-clamp-2")}
          data-testid="public-notice-summary"
        >
          {n.summary}
        </p>
      )}
      {expandable && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={summaryId}
          className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary underline-offset-2 hover:underline"
          data-testid="public-notice-toggle"
        >
          {open ? t("收起") : t("展开")}
          <IconChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      )}
    </li>
  )
}
