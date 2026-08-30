import { Link } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { IconCheck, IconExternalLink } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { StatusPill } from '../_shared/status'
import type { Notification } from './api'
import { categoryMeta, type TFn } from './shared'
import type { features } from './table-features'

const col = createColumnHelper<typeof features, Notification>()

export function buildColumns(
  /** 可点就返回目标路由，不可点返回 null（见 `use-open.ts`） */
  linkOf: (n: Notification) => string | null,
  /** 未读才发已读请求 */
  readIfUnread: (n: Notification) => void,
  onMarkRead: (n: Notification) => void,
  /** 普通函数不能自己调 hook —— 由组件传进来（i18n 分册第 5 条） */
  t: TFn
) {
  return [
    col.accessor('title', {
      header: t('标题'),
      cell: ({ row, getValue }) => {
        const n = row.original
        const to = linkOf(n)
        const className = cn(
          'flex max-w-[18rem] items-center gap-1.5 truncate text-start text-sm underline-offset-2 hover:underline',
          to ? 'text-primary' : 'text-foreground',
          // 未读加粗 —— 「状态」列之外再给一个不用横向找的信号
          !n.read_time && 'font-semibold'
        )
        const body = (
          <>
            <span className="truncate">{getValue()}</span>
            {to && <IconExternalLink className="size-3.5 shrink-0 opacity-60" />}
          </>
        )
        // 🔴 用 `<Link>` 不用 `useNavigate()`：页面组件要 router-独立（硬纪律 1），
        // `<Link>` 走 router context，隐藏 tab 里也拿得到。
        // `to` 是库里的自由字符串、已经过 `isValidPath` 校验，
        // 而 TanStack 的 `to` 类型是已知路由的字面量联合 —— 动态值只能断言过去
        return to ? (
          <Link
            to={to as never}
            search={{} as never}
            onClick={() => readIfUnread(n)}
            data-testid={`open-notification-${n.id}`}
            data-unread={!n.read_time}
            className={className}
          >
            {body}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => readIfUnread(n)}
            data-testid={`open-notification-${n.id}`}
            data-unread={!n.read_time}
            className={className}
          >
            {body}
          </button>
        )
      },
    }),
    col.accessor('category', {
      header: t('分类'),
      cell: ({ getValue }) => {
        const meta = categoryMeta(getValue())
        return (
          <Badge variant="outline" className="gap-1 font-normal">
            <meta.Icon className="size-3" />
            {t(meta.label)}
          </Badge>
        )
      },
    }),
    col.accessor('read_time', {
      id: 'state',
      header: t('状态'),
      cell: ({ getValue }) =>
        getValue() ? (
          <StatusPill tone="muted">{t('已读')}</StatusPill>
        ) : (
          <StatusPill tone="warning">{t('未读')}</StatusPill>
        ),
    }),
    col.accessor('recipient_id', {
      header: t('范围'),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">
          {getValue() ? t('仅我可见') : t('全员')}
        </span>
      ),
    }),
    col.accessor('content', {
      header: t('内容'),
      cell: ({ getValue }) => (
        // 🔴 `block` + `truncate`，**不要** `line-clamp-1`：Tailwind 的 line-clamp
        // 靠 `display:-webkit-box` 实现，而这一格还需要 `block` 才能让 `max-w-*`
        // 生效 —— 两个 display 打架，谁后写谁赢。line-clamp 输掉之后只剩
        // `overflow:hidden`，正文被**齐字切断、没有省略号**，看着像数据坏了
        // 而不像截断（实测踩过）。单行截断本来就该用 `truncate`。
        <span className="block max-w-[16rem] truncate text-sm text-muted-foreground">
          {getValue()}
        </span>
      ),
    }),
    col.accessor('created_time', {
      header: t('时间'),
      cell: ({ getValue }) => (
        <span className="text-sm tabular-nums text-muted-foreground">
          {formatDateTime(getValue())}
        </span>
      ),
    }),
    col.display({
      id: 'actions',
      header: () => <span className="sr-only">{t('操作')}</span>,
      cell: ({ row }) => {
        const n = row.original
        // 已读的行不摆一个禁用的按钮 —— 「标记已读」对它没有任何意义，
        // 禁用态还会因为 `disabled:pointer-events-none` 连 tooltip 都打不开
        // （[ui 分册](../../../../ui/AGENTS.md) 那条）。
        // 阅读时间收进 tooltip 而不是直接摊在单元格里：它只有偶尔要看，
        // 摊开会让这一列宽到把整张表推出视口。
        if (n.read_time) {
          return (
            <Tooltip>
              <TooltipTrigger
                render={<span className="block w-7 text-center text-muted-foreground/60" />}
              >
                <IconCheck className="inline size-4" />
              </TooltipTrigger>
              <TooltipContent>
                {t('已读于 {{at}}', { at: formatDateTime(n.read_time) })}
              </TooltipContent>
            </Tooltip>
          )
        }
        return (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('标记已读')}
                  data-testid={`notification-read-${n.id}`}
                  onClick={() => onMarkRead(n)}
                />
              }
            >
              <IconCheck className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t('标记已读')}</TooltipContent>
          </Tooltip>
        )
      },
    }),
  ]
}

export const COLUMN_LABELS: Record<string, string> = {
  title: '标题',
  category: '分类',
  state: '状态',
  recipient_id: '范围',
  content: '内容',
  created_time: '时间',
}
