import { PaperclipIcon, PinIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { Pressable, View } from 'react-native'

import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import type { NoticeFeedItem } from '@/lib/contract'
import { relativeTime } from '@/lib/datetime'
import { NOTICE_LEVEL_LABEL } from '@/lib/notices'

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
          <Text className="text-muted-foreground font-mono text-[11px]">{relativeTime(notice.created_time)}</Text>
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
