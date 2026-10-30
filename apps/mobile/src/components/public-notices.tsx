import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'

import { Group, GroupHeader } from '@/components/grouped'
import { NoticeLevelBadge, PinnedMark } from '@/components/notice'
import { Text } from '@/components/ui/text'
import type { NoticePublicItem } from '@/lib/contract'
import { usePublicNotices } from '@/lib/notices'
import { cn } from '@/lib/utils'

/** 摘要默认显示几行。超出的整行可点、展开看完整摘要（摘要本身最多 200 字，后端截好的） */
const SUMMARY_LINES = 2

/**
 * 登录屏上的公告（#190，`GET /sys/notices/public`，不用登录）：标题 + 级别 + 摘要（可展开）。
 *
 * 三种状态，都**不挡登录**（它放在表单下面，加载 / 失败都不占表单的位置）：
 *
 * | | 长什么样 |
 * |---|---|
 * | 加载中 / 空 | 什么都不出 —— 空的时候一块「暂无公告」对要登录的人没有信息量 |
 * | 有 | 「公告」分组，一条一行 |
 * | 失败（且手上没有上一次的） | 一行很轻的「公告加载失败 · 重试」—— 硬纪律 9：不能静默地变成「没有公告」，但也不该用红色错误块把登录屏搞得像出了故障 |
 *
 * ⚠️ **不显示时间**：这个接口只给 `created_time`、没有 `publish_time`，定时发布的公告拿建好的时间当
 * 「发布时间」是错的（其他地方都用 `publish_time ?? created_time`）
 */
export function PublicNotices() {
  const { t } = useTranslation()
  const q = usePublicNotices()

  if (q.isError && !q.data) {
    return (
      <View className="flex-row items-center gap-1.5 px-5 pt-5" testID="login-notices-error">
        <Text className="text-muted-foreground text-[12px]">{t('公告加载失败')}</Text>
        <Text className="text-muted-foreground text-[12px]">·</Text>
        {q.isFetching ? (
          <ActivityIndicator size="small" />
        ) : (
          <Pressable onPress={() => void q.refetch()} hitSlop={8} testID="login-notices-retry">
            <Text className="text-[12px] font-medium underline">{t('重试')}</Text>
          </Pressable>
        )}
      </View>
    )
  }

  const items = q.data ?? []
  if (items.length === 0) return null

  return (
    <View testID="login-notices">
      <GroupHeader>{t('公告')}</GroupHeader>
      <Group>
        {items.map((n, i) => (
          <PublicNoticeRow key={String(n.id)} notice={n} first={i === 0} />
        ))}
      </Group>
    </View>
  )
}

function PublicNoticeRow({ notice, first }: { notice: NoticePublicItem; first: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  /*
   * 摘要不截断时有几行。`onTextLayout` 量的是**下面那份不限行数的隐形副本**：限了 `numberOfLines`
   * 的那份报不报被截掉的行，RN 没有给保证（两端的文字排版是各自的原生实现，没在设备上核过），
   * 量一份不限行数的就不依赖这一点。副本和正文同宽、同字号，量出来的行数就是展开后的行数
   */
  const [lines, setLines] = React.useState(0)
  const truncatable = lines > SUMMARY_LINES
  const summaryClass = 'text-muted-foreground text-[13px] leading-5'

  return (
    <>
      {first ? null : <View className="bg-border ml-5 h-px" />}
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        disabled={!truncatable}
        accessibilityState={{ expanded }}
        testID="login-notice-row"
        className={cn('min-h-[46px] gap-1 px-5 py-2.5', truncatable && 'active:bg-muted')}
      >
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-[15px] font-medium" numberOfLines={2}>
            {notice.title}
          </Text>
          {notice.pinned ? <PinnedMark /> : null}
          <NoticeLevelBadge level={notice.level} />
        </View>
        {notice.summary ? (
          <View>
            <Text className={summaryClass} numberOfLines={expanded ? undefined : SUMMARY_LINES}>
              {notice.summary}
            </Text>
            <View
              pointerEvents="none"
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              className="absolute inset-x-0 top-0 opacity-0"
            >
              <Text className={summaryClass} onTextLayout={(e) => setLines(e.nativeEvent.lines.length)}>
                {notice.summary}
              </Text>
            </View>
          </View>
        ) : null}
        {truncatable ? (
          <Text className="text-muted-foreground text-[12px] font-medium">{expanded ? t('收起') : t('展开')}</Text>
        ) : null}
      </Pressable>
    </>
  )
}
