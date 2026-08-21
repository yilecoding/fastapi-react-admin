import { createColumnHelper } from '@tanstack/react-table'
import { IconDotsVertical, IconEye, IconPencil, IconTrash } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { richTextToPlain } from '@admin/ui/components/rich-text'
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
import { NOTICE_TYPE_LABEL, type Notice } from './api'
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

export function buildColumns(
  onView: (n: Notice) => void,
  onEdit: (n: Notice) => void,
  onDelete: (n: Notice) => void,
  /** 普通函数不能自己调 hook —— 由组件传进来 */
  t: (k: string, vars?: Record<string, unknown>) => string
) {
  return [
    buildSelectColumn(col, {}, t),
    col.accessor('title', {
      header: t('标题'),
      cell: ({ row, getValue }) => (
        <button
          type="button"
          onClick={() => onView(row.original)}
          data-testid={`open-notice-${row.original.id}`}
          className="max-w-[22rem] truncate text-start text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          {getValue()}
        </button>
      ),
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
      cell: ({ getValue }) =>
        getValue() === 1 ? (
          <StatusPill tone="success">{t('显示')}</StatusPill>
        ) : (
          <StatusPill tone="muted">{t('隐藏')}</StatusPill>
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
        <span className="text-sm tabular-nums text-muted-foreground">{getValue()}</span>
      ),
    }),
    col.accessor('updated_time', {
      header: t('更新时间'),
      cell: ({ getValue }) => (
        <span className="text-sm tabular-nums text-muted-foreground">
          {getValue() || <span className="text-muted-foreground/60">—</span>}
        </span>
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
  type: '类型',
  status: '状态',
  content: '内容摘要',
  created_time: '创建时间',
  updated_time: '更新时间',
}
