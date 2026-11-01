import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconCalendarEvent, IconFileText, IconKey, IconPlane, IconReceipt, IconShoppingCart, IconSignature, IconUserPlus,
} from '@tabler/icons-react'

import { cn } from '@admin/ui/lib/utils'

import { deskStartableQuery, type StartableDef } from '../api'
import { CARD_ACTION_CLASS, DashboardCard } from '../card-shell'

/** 卡片里放几个（2 × 2） */
const MAX = 4

/**
 * 模板图标：按名字 / 分组里的关键词挑一个。
 *
 * ⚠️ 流程定义上的 `icon` 是 Iconify 名（`mdi:beach`），前端的图标表（`shell/icon-registry.tsx`）只收了菜单用到的那几个，
 * 认不出的会退成一个圆点 —— 所以这里不用它，按关键词给一个说得过去的，认不出的一律「文档」
 */
const ICONS: [string[], typeof IconFileText][] = [
  [['假', '休', 'leave'], IconCalendarEvent],
  [['报销', '费用', '发票', 'expense'], IconReceipt],
  [['采购', '购买', 'purchase'], IconShoppingCart],
  [['用印', '盖章', '印章', 'seal'], IconSignature],
  [['出差', '差旅', 'travel'], IconPlane],
  [['权限', '授权', 'permission'], IconKey],
  [['账号', '入职', 'onboard'], IconUserPlus],
]

const TINTS = [
  'bg-primary/10 text-primary',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
]

function iconOf(d: StartableDef): typeof IconFileText {
  // 关键词写成字符串不写正则：正则字面量里的中文会被 `i18n:jsx` 当成裸露的 JSX 文本
  const text = `${d.name} ${d.category ?? ''}`.toLowerCase()
  return ICONS.find(([words]) => words.some((w) => text.includes(w)))?.[1] ?? IconFileText
}

/**
 * 「快速发起」（#202）：可发起的模板，按「我最近发起的次数」排（后端给 `my_recent_count`，近 90 天）。
 * 一张都没发起过时就是模板本身的顺序 —— 底下那行小字照实说，不写「按常用排」
 */
export function QuickStartCard() {
  const { t } = useTranslation()
  const query = useQuery(deskStartableQuery)
  const defs = React.useMemo(() => {
    // 稳定排序：次数一样的保持模板顺序（后端按 sort, id 排好的）
    return [...(query.data ?? [])].sort((a, b) => b.my_recent_count - a.my_recent_count)
  }, [query.data])
  const byUsage = defs.some((d) => d.my_recent_count > 0)

  return (
    <DashboardCard
      variant="tile"
      testId="dash-quick-start"
      title={t('快速发起')}
      action={
        <Link to="/workflow/inbox" search={{}} className={CARD_ACTION_CLASS} data-testid="dash-quick-start-all">
          {t('全部模板')}
        </Link>
      }
      footer={<span>{byUsage ? t('按你最近发起的次数排') : t('按模板顺序排')}</span>}
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={Boolean(query.data)}
      empty={defs.length === 0}
      emptyText={t('还没有可以发起的审批')}
    >
      <div className="grid grid-cols-2 gap-2">
        {defs.slice(0, MAX).map((d, i) => {
          const Icon = iconOf(d)
          return (
            <Link
              key={d.code}
              to="/workflow/inbox"
              search={{ start: d.code }}
              className="flex h-[46px] min-w-0 items-center gap-2.5 rounded-[10px] border border-border px-3 font-semibold transition-colors hover:border-primary/40 hover:bg-muted/40"
              data-testid={`dash-quick-start-${d.code}`}
            >
              <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', TINTS[i % TINTS.length])} aria-hidden>
                <Icon className="size-[15px]" />
              </span>
              <span className="truncate">{d.name}</span>
            </Link>
          )
        })}
      </div>
    </DashboardCard>
  )
}
