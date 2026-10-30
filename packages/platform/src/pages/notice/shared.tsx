import { useTranslation } from 'react-i18next'
import { IconPaperclip, IconPinFilled } from '@tabler/icons-react'

import { cn } from '@admin/ui/lib/utils'

import { StatusPill } from '../_shared/status'
import { NOTICE_LEVEL, NOTICE_LEVEL_LABEL } from './api'

/**
 * 公告的几个小标记，读者那边（工作台卡片 / 详情 / 铃铛 / 消息中心）和管理页共用一份 ——
 * 同一条公告在两处长得不一样，读的人会以为是两条。
 */

/**
 * 级别药丸。**普通级不画**：一列全是「普通」是噪音，只有重要 / 紧急才值得占位。
 * 管理页要显示「普通」三个字的地方传 `showNormal`。
 */
export function NoticeLevelPill({
  level,
  showNormal = false,
  className,
}: {
  level: number
  showNormal?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  if (level === NOTICE_LEVEL.URGENT) {
    return (
      <StatusPill tone="danger" className={className} data-testid="notice-level" data-level={level}>
        {t('紧急')}
      </StatusPill>
    )
  }
  if (level === NOTICE_LEVEL.IMPORTANT) {
    return (
      <StatusPill tone="warning" className={className} data-testid="notice-level" data-level={level}>
        {t('重要')}
      </StatusPill>
    )
  }
  if (!showNormal) return null
  return (
    <StatusPill tone="muted" className={className} data-testid="notice-level" data-level={level}>
      {t(NOTICE_LEVEL_LABEL[level] ?? '普通')}
    </StatusPill>
  )
}

/** 置顶标记。图标 + 读屏文案（列表行里只放图标，宽度紧） */
export function PinnedMark({ withLabel = false, className }: { withLabel?: boolean; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-xs text-sky-600 dark:text-sky-400', className)}
      data-testid="notice-pinned"
      title={t('置顶')}
    >
      <IconPinFilled className="size-3.5" aria-hidden />
      {withLabel ? t('置顶') : <span className="sr-only">{t('置顶')}</span>}
    </span>
  )
}

/**
 * 📎 + 个数。没有附件就**什么都不画**（`count` 是 0 / null / undefined 都算没有）——
 * 让读者打开之前就知道「这条带文件」，而不是每一行都挂一个 0。
 */
export function AttachmentCount({ count, className }: { count: number | null | undefined; className?: string }) {
  const { t } = useTranslation()
  if (!count) return null
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground', className)}
      data-testid="attachment-count"
      title={t('{{n}} 个附件', { n: count })}
    >
      <IconPaperclip className="size-3.5" aria-hidden />
      <span aria-hidden>{count}</span>
      <span className="sr-only">{t('{{n}} 个附件', { n: count })}</span>
    </span>
  )
}
