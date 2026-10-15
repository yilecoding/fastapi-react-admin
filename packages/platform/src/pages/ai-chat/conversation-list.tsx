import { IconPlus, IconTrash } from '@tabler/icons-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { Skeleton } from '@admin/ui/components/skeleton'

import type { Conversation } from './api'

/**
 * 按「最近」把会话分段。
 *
 * 🔴 这一步不是装饰，是这份列表能不能用的前提：会话标题默认都是「新对话」，
 * 实测一屏 45 条**全都叫同一个名字**，唯一的区分是第二行那个时间戳 ——
 * 于是人要做的事变成"用眼睛做二分查找"。分了段之后，"今天"那一段通常只有
 * 三五条，而那几乎总是要找的那一条。
 *
 * 分段口径刻意粗（今天 / 昨天 / 最近 7 天 / 更早），不做"3 天前"这种精确档：
 * 档位越多每段越少，段标题本身就变成了新的噪音。
 */
const BUCKETS = ['今天', '昨天', '最近 7 天', '更早'] as const
type Bucket = (typeof BUCKETS)[number]

function bucketOf(iso: string, now: Date): Bucket {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '更早'
  // 按**自然日**算，不是 24 小时：23:50 发的会话到第二天 00:10 应该落进「昨天」，
  // 而不是还算「今天」——人对"昨天"的理解是日历上的昨天
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days <= 7) return '最近 7 天'
  return '更早'
}

function groupByRecency(conversations: Conversation[]): [Bucket, Conversation[]][] {
  const now = new Date()
  const map = new Map<Bucket, Conversation[]>()
  for (const c of conversations) {
    const key = bucketOf(c.updated_time ?? c.created_time, now)
    const list = map.get(key)
    if (list) list.push(c)
    else map.set(key, [c])
  }
  // 按固定顺序输出，空段不出现 —— 顺序跟着数据走的话，段标题会在刷新之间跳动
  return BUCKETS.filter((b) => map.has(b)).map((b) => [b, map.get(b)!])
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  onDelete,
}: {
  conversation: Conversation
  active: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className={`group relative flex items-center rounded-lg transition-colors ${
        active ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
    >
      {/* 选中态用左侧一条主色竖线，而不是只靠底色——底色在深色主题下几乎看不出来 */}
      {active ? (
        <span className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" aria-hidden />
      ) : null}
      <button type="button" className="min-w-0 flex-1 px-2.5 py-1.5 text-start" onClick={onSelect}>
        <span className={`block truncate text-[13px] leading-5 ${active ? 'font-medium' : ''}`}>
          {conversation.title}
        </span>
        <span className="block truncate text-[10.5px] leading-4 text-muted-foreground">
          {formatDateTime(conversation.updated_time ?? conversation.created_time)}
        </span>
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="me-1 size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t('删除会话 {{title}}', { title: conversation.title })}
        onClick={onDelete}
      >
        <IconTrash className="size-3.5" />
      </Button>
    </div>
  )
}

/**
 * 左栏会话选择器。
 *
 * 骨架照 `_shared/master-list.tsx` 的口径：标题钉住、只有列表滚。
 */
export function ConversationList({
  conversations,
  activeId,
  loading,
  creating,
  onSelect,
  onCreate,
  onDelete,
}: {
  conversations: Conversation[]
  activeId?: string
  loading: boolean
  creating: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}) {
  const { t } = useTranslation()
  const groups = React.useMemo(() => groupByRecency(conversations), [conversations])

  return (
    <aside className="flex w-full shrink-0 flex-col rounded-xl border bg-card lg:w-64 content-scroll:lg:min-h-0">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">
          {t('会话')}
          {conversations.length ? (
            <span className="ms-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {conversations.length}
            </span>
          ) : null}
        </span>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onCreate} disabled={creating}>
          <IconPlus className="size-3.5" />
          {t('新建')}
        </Button>
      </div>

      <div className="max-h-[40svh] min-h-0 flex-1 overflow-y-auto p-1.5 lg:max-h-none">
        {loading ? (
          <div className="space-y-1.5 p-1">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('还没有会话')}</p>
        ) : (
          groups.map(([label, items]) => (
            <section key={label} className="mb-1 last:mb-0">
              {/* 段标题钉住：一段有二三十条时，滚到中间还知道自己在哪一段 */}
              <h3 className="sticky top-0 z-10 bg-card/95 px-2.5 py-1 text-[10.5px] font-medium tracking-wide text-muted-foreground backdrop-blur-sm">
                {t(label)}
              </h3>
              <div className="space-y-0.5">
                {items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    onSelect={() => onSelect(c.id)}
                    onDelete={() => onDelete(c.id)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}
