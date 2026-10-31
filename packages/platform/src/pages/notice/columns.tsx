import { createColumnHelper } from '@tanstack/react-table'
import { IconChartBar, IconDotsVertical, IconEye, IconPencil, IconTrash } from '@tabler/icons-react'

import { formatDateTime, formatDateTimeShort } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { richTextToPlain } from '@admin/ui/components/rich-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'

import { Can } from '../../auth/can'
import { buildSelectColumn } from '../_shared/select-column'
import { StatusPill } from '../_shared/status'
import { NOTICE_TYPE_LABEL, isExpired, isScheduled, type Notice, type NoticeAudienceItem } from './api'
import { AttachmentCount, NoticeLevelPill, PinnedMark, RequireAckMark } from './shared'
import type { features } from './table-features'

const col = createColumnHelper<typeof features, Notice>()

/**
 * 正文是富文本 HTML，列表里只给一行纯文本预览，全文走详情抽屉。
 * 不剥标签的话摘要会变成 `<p>关于…`，一列全是尖括号。
 *
 * `[图片]` 那个占位不能省：`richTextToPlain` 默认会把 `<img>` 连标签一起吃掉，
 * 于是**纯图片的公告在这一列是空单元格**，看起来像数据坏了。
 * 它是纯函数，调不了 hook —— `t` 从 `buildColumns` 传下来。
 */
const preview = (content: string, t: (k: string) => string) =>
  richTextToPlain(content, 60, t('[图片]'))

type T = (k: string, vars?: Record<string, unknown>) => string

/**
 * 发布范围那一格（#190）：空 = 「全员」；否则「2 个部门 · 1 个角色 · 3 人」，悬停列出名字（`audience[].name`，
 * 后端带回来的显示名；对象删了是 `null` —— 照样列出来、标「已删除」，那正是要人去改的地方）
 */
function AudienceCell({ audience, t }: { audience: NoticeAudienceItem[]; t: T }) {
  if (!audience.length) {
    return (
      <StatusPill tone="muted" data-testid="notice-audience" data-audience="all">
        {t('全员')}
      </StatusPill>
    )
  }
  const count = (k: NoticeAudienceItem['kind']) => audience.filter((x) => x.kind === k).length
  const parts = [
    count('dept') && t('{{n}} 个部门', { n: count('dept') }),
    count('role') && t('{{n}} 个角色', { n: count('role') }),
    count('user') && t('{{n}} 人', { n: count('user') }),
  ].filter(Boolean)
  const kindLabel: Record<NoticeAudienceItem['kind'], string> = { dept: t('部门'), role: t('角色'), user: t('人员') }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // 直接拿药丸当锚点（不包 `display:contents` 的壳，ui 分册：那样气泡会飞到左上角）
          <StatusPill
            tone="info"
            tabIndex={0}
            className="cursor-default whitespace-nowrap"
            data-testid="notice-audience"
            data-audience="some"
          />
        }
      >
        {parts.join(' · ')}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <ul className="flex flex-col gap-0.5 text-start">
          {audience.map((x) => (
            <li key={`${x.kind}:${x.target_id}`}>
              <span className="opacity-70">{kindLabel[x.kind]} · </span>
              {x.name ?? t('（已删除）')}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

export function buildColumns(
  onView: (n: Notice) => void,
  onEdit: (n: Notice) => void,
  onDelete: (n: Notice) => void,
  /** 阅读统计抽屉（#190）。开着哪条写进 URL，由页面管 */
  onReads: (n: Notice) => void,
  /** 普通函数不能自己调 hook —— 由组件传进来 */
  t: T
) {
  return [
    buildSelectColumn(col, {}, t),
    col.accessor('title', {
      header: t('标题'),
      cell: ({ row, getValue }) => (
        <span className="flex max-w-[24rem] items-center gap-1.5">
          {row.original.pinned && <PinnedMark />}
          <button
            type="button"
            onClick={() => onView(row.original)}
            data-testid={`open-notice-${row.original.id}`}
            className="min-w-0 truncate text-start text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            {getValue()}
          </button>
          {/* 📎 个数（#190 起管理列表也带 `attachment_count`）：没有附件不画 */}
          <AttachmentCount count={row.original.attachment_count} />
        </span>
      ),
    }),
    col.accessor('level', {
      header: t('级别'),
      cell: ({ getValue }) => <NoticeLevelPill level={getValue()} showNormal />,
    }),
    col.accessor('type', {
      header: t('类型'),
      cell: ({ getValue }) => (
        <Badge variant="outline" className="font-normal">
          {t(NOTICE_TYPE_LABEL[getValue()] ?? '—')}
        </Badge>
      ),
    }),
    col.accessor('status', {
      header: t('状态'),
      // 这里的语义是显示/隐藏，不是正常/停用 —— 所以用 StatusPill 自带文案，
      // 不用 StatusBadge（那个写死了「正常 / 停用」）
      // 「已过期」挂在状态旁边而不是另起一列：「显示 + 已过期」= 读者看不到，
      // 两个放一起才读得出这层意思（管理页照样列出过期的，这正是要提醒的）
      // 「定时 · 时间」（#190）顶替「显示」：显示中但还没到点 = 读者现在看不到，这正是要一眼看出来的；
      // 隐藏的照旧写「隐藏」（到点也不会发），时间放在后面那一枚里
      cell: ({ row, getValue }) => (
        <span className="flex flex-wrap items-center gap-1">
          {getValue() === 1 && isScheduled(row.original.publish_time) ? (
            <StatusPill tone="info" data-testid={`notice-scheduled-${row.original.id}`}>
              {t('定时 · {{at}}', { at: formatDateTimeShort(row.original.publish_time) })}
            </StatusPill>
          ) : getValue() === 1 ? (
            <StatusPill tone="success">{t('显示')}</StatusPill>
          ) : (
            <StatusPill tone="muted">{t('隐藏')}</StatusPill>
          )}
          {getValue() !== 1 && isScheduled(row.original.publish_time) && (
            <StatusPill tone="muted">{t('定时 · {{at}}', { at: formatDateTimeShort(row.original.publish_time) })}</StatusPill>
          )}
          {isExpired(row.original.expire_time) && (
            <StatusPill tone="muted" data-testid={`notice-expired-${row.original.id}`}>
              {t('已过期')}
            </StatusPill>
          )}
        </span>
      ),
    }),
    col.accessor('audience', {
      header: t('发布范围'),
      cell: ({ getValue }) => <AudienceCell audience={getValue() ?? []} t={t} />,
    }),
    col.display({
      id: 'reach',
      header: t('触达方式'),
      // 弹窗 / 必读 / 登录页三个开关的标记；都没开就空着（大多数公告是这样，一列「否」是噪音）
      cell: ({ row }) => {
        const n = row.original
        if (!n.popup && !n.public) return null
        return (
          // 不换行：这一列窄，换行会把「弹窗 / 必读」竖着叠成两行、整行被撑高（截图里看到的）
          <span className="flex items-center gap-1 whitespace-nowrap" data-testid={`notice-reach-${n.id}`}>
            {n.popup && <StatusPill tone="info">{t('弹窗')}</StatusPill>}
            {n.require_ack && <RequireAckMark />}
            {n.public && <StatusPill tone="muted">{t('登录页')}</StatusPill>}
          </span>
        )
      },
    }),
    col.accessor('expire_time', {
      header: t('过期时间'),
      cell: ({ getValue }) => (
        // 空值 formatDateTime 给 '—'（= 不过期）
        <span className="text-sm tabular-nums text-muted-foreground">{formatDateTime(getValue())}</span>
      ),
    }),
    col.accessor('content', {
      header: t('内容摘要'),
      cell: ({ getValue }) => {
        const text = preview(getValue(), t)
        return (
          <span className="text-sm text-muted-foreground">
            {text || <span className="text-muted-foreground/60">{t('（空）')}</span>}
          </span>
        )
      },
    }),
    col.accessor('created_time', {
      header: t('创建时间'),
      cell: ({ getValue }) => (
        <span className="text-sm tabular-nums text-muted-foreground">{formatDateTime(getValue())}</span>
      ),
    }),
    col.accessor('updated_time', {
      header: t('更新时间'),
      cell: ({ getValue }) => (
        // 空值由 formatDateTime 统一给 '—'，不用再判一次
        <span className="text-sm tabular-nums text-muted-foreground">{formatDateTime(getValue())}</span>
      ),
    }),
    col.display({
      id: 'actions',
      header: () => <span className="sr-only">{t('操作')}</span>,
      cell: ({ row }) => {
        const n = row.original
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" className="size-7" aria-label={t('操作 {{name}}', { name: n.title })} />}
              data-testid={`notice-actions-${n.id}`}
            >
              <IconDotsVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={() => onView(n)} data-testid={`notice-view-${n.id}`}>
                <IconEye className="size-4" />
                {t('查看全文')}
              </DropdownMenuItem>
              {/* 接口和管理页同一个码（`sys:notice:add`），能进这一页就能看 */}
              <DropdownMenuItem onClick={() => onReads(n)} data-testid={`notice-reads-${n.id}`}>
                <IconChartBar className="size-4" />
                {t('阅读统计')}
              </DropdownMenuItem>
              <Can perm="sys:notice:edit" fallback={null}>
                <DropdownMenuItem onClick={() => onEdit(n)} data-testid={`notice-edit-${n.id}`}>
                  <IconPencil className="size-4" />
                  {t('编辑')}
                </DropdownMenuItem>
              </Can>
              <Can perm="sys:notice:del">
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDelete(n)}
                  data-testid={`notice-delete-${n.id}`}
                >
                  <IconTrash className="size-4" />
                  {t('删除')}
                </DropdownMenuItem>
              </Can>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    }),
  ]
}

export const COLUMN_LABELS: Record<string, string> = {
  title: '标题',
  level: '级别',
  type: '类型',
  status: '状态',
  audience: '发布范围',
  reach: '触达方式',
  expire_time: '过期时间',
  content: '内容摘要',
  created_time: '创建时间',
  updated_time: '更新时间',
}
