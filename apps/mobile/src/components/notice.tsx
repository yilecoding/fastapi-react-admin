import { PaperclipIcon, PinIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { Pressable, View } from 'react-native'

import { AttachmentList } from '@/components/attachment-list'
import { GroupHeader } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import type { NoticeFeedItem } from '@/lib/contract'
import { relativeTime } from '@/lib/datetime'
import { NOTICE_LEVEL_LABEL, noticePublishedAt, useNoticeAttachments } from '@/lib/notices'

/**
 * 公告的几个小件：级别徽标 · 置顶标记 · 附件个数 · 首页那一行。
 *
 * 🔴 **颜色只给「紧急」**（语义红）。「重要」走中性的 `secondary` —— 移动端没有琥珀色令牌，
 * 而自创一个令牌要 light / dark 两份同时加（少一个 uniwind 只打警告、`expo export`
 * 照样成功、那个颜色隐形，`src/components/` 分册记着）。两档靠文字区分已经够了。
 */
export function NoticeLevelBadge({ level }: { level: number }) {
  const { t } = useTranslation()
  const label = NOTICE_LEVEL_LABEL[level]
  if (!label) return null
  return (
    <Badge variant={level >= 2 ? 'destructive' : 'secondary'} className="px-1.5 py-0">
      <Text className="text-[11px]">{t(label)}</Text>
    </Badge>
  )
}

/** 置顶：一枚图钉 + 字。和级别并排时不抢眼 */
export function PinnedMark() {
  const { t } = useTranslation()
  return (
    <View className="flex-row items-center gap-0.5">
      <Icon as={PinIcon} className="text-muted-foreground size-3" />
      <Text className="text-muted-foreground text-[11px]">{t('置顶')}</Text>
    </View>
  )
}

/**
 * 📎 + 个数。没有附件（0 / null）什么都不出 —— 读者在点开之前就该知道「这条有文件」，
 * 但「没有文件」不需要被告知。
 */
export function AttachmentCount({ count }: { count: number | null | undefined }) {
  const { t } = useTranslation()
  if (!count || count <= 0) return null
  return (
    <View
      className="flex-row items-center gap-0.5"
      accessibilityLabel={t('{{n}} 个附件', { n: count })}
      testID="attachment-count"
    >
      <Icon as={PaperclipIcon} className="text-muted-foreground size-3" />
      <Text className="text-muted-foreground font-mono text-[11px]">{count}</Text>
    </View>
  )
}

/**
 * 首页「公告」组里的一行。放在 `Group` 里（定长、最多几条），所以分隔线照
 * `grouped.tsx` 的规矩画在非首行顶部、内缩到内容起点。
 *
 * 未读只用一枚主色圆点 + 标题加粗（和通知屏同一个表达），级别 / 置顶 / 附件是**属性**，
 * 不染主色。
 */
export function NoticeRow({
  notice,
  first,
  onPress,
}: {
  notice: NoticeFeedItem
  first?: boolean
  onPress: () => void
}) {
  const unread = !notice.read
  const hasMeta = notice.pinned || notice.level > 0 || notice.attachment_count > 0
  return (
    <>
      {first ? null : <View className="bg-border ml-5 h-px" />}
      <Pressable
        onPress={onPress}
        testID="home-notice-row"
        className="active:bg-muted min-h-[46px] justify-center gap-1 px-5 py-2.5"
      >
        <View className="flex-row items-center gap-2">
          {unread ? <View className="bg-primary h-1.5 w-1.5 rounded-full" /> : null}
          <Text className={`flex-1 text-[15px] ${unread ? 'font-semibold' : ''}`} numberOfLines={1}>
            {notice.title}
          </Text>
          <Text className="text-muted-foreground font-mono text-[11px]">{relativeTime(noticePublishedAt(notice))}</Text>
        </View>
        {hasMeta ? (
          <View className="flex-row items-center gap-2">
            {notice.pinned ? <PinnedMark /> : null}
            <NoticeLevelBadge level={notice.level} />
            <AttachmentCount count={notice.attachment_count} />
          </View>
        ) : null}
      </Pressable>
    </>
  )
}

/**
 * 公告的附件区（详情屏和登录后弹窗共用，#190 从详情屏里拆出来）。
 *
 * 没有附件整块不出（读者不需要看到「暂无附件」）。个数以列表为准 —— 后端只列这个人读得了的，
 * 可能比 `attachment_count` 少；列表拉回来是空的也整块收起。
 * 拉取失败要**占住位置**报出来（硬纪律 9）：否则读者看到的是「这条没有附件」，而列表上明明有 📎。
 *
 * ⚠️ 查询和调用方共用同一个 key（`noticesKey.attachments(id)`）：详情屏自己也挂着一份，下拉刷新时一起重拉
 */
export function NoticeAttachments({ noticeId, count }: { noticeId: string; count: number }) {
  const { t } = useTranslation()
  const has = count > 0
  const files = useNoticeAttachments(noticeId, has)
  const list = files.data ?? null
  if (!has || (list && list.length === 0)) return null
  return (
    <>
      <GroupHeader>{t('附件（{{n}}）', { n: list?.length ?? count })}</GroupHeader>
      {files.isError ? (
        <View className="px-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('附件加载失败')}</AlertTitle>
            <AlertDescription>{files.error instanceof Error ? files.error.message : String(files.error)}</AlertDescription>
            <Button variant="outline" size="sm" onPress={() => void files.refetch()} className="mt-2 self-start">
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : list === null ? (
        <View className="gap-2 px-4">
          <Skeleton className="h-[54px] rounded-xl" />
        </View>
      ) : (
        <AttachmentList files={list} />
      )}
    </>
  )
}
