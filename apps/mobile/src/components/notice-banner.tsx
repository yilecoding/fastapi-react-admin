import { useRouter } from 'expo-router'
import { ChevronRightIcon, MegaphoneIcon, XIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Chevron } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import type { NoticeFeedItem } from '@/lib/contract'
import { relativeTime } from '@/lib/datetime'
import { isNoticeGone, noticePublishedAt, useMarkNoticeRead } from '@/lib/notices'

/**
 * 首页顶部的横幅（#190）：置顶 + 紧急 + 我没读（`GET /feed/banner`，最多 3 条）。
 * 点标题 → 详情屏；✕ → 标已读（「已知悉」，跟着人走、不另建表）。
 *
 * 🔴 **必须确认的（`require_ack`）不给 ✕**（和 web 的横幅同一个做法）：后端对它只认显式已读，
 * 关横幅走的是同一个标已读接口 —— 给了 ✕ 就等于在没读正文的情况下替他点了「我已阅读」。
 * 那一条写明「点标题阅读并确认」，右边是一枚 chevron，进详情屏底部只有「我已阅读」。
 *
 * 数据由首页传进来（首页的下拉刷新要能一起重拉它），这里只管画和关。
 *
 * 🔴 **颜色只给图标**（语义红 = 紧急，和级别徽标同一个规矩，`components/notice.tsx` 头注释）。
 * 整块染红会比首页任何东西都艳，而它只是一行提示 —— `src/components/` 分册「主色和语义色只能出现在这几处」。
 *
 * ⚠️ 拉取失败不在这里报：横幅下面紧挨着的「公告」组读的是同一批公告（置顶排在最前），
 * 它有自己的失败态；这里再报一次就是同一个错在一屏里出现两遍。
 */
export function NoticeBanner({ items }: { items: NoticeFeedItem[] }) {
  const { t } = useTranslation()
  const router = useRouter()
  const { mutateAsync: markRead } = useMarkNoticeRead()
  /*
   * 点了 ✕ 的先从本地藏掉：标已读成功后横幅那个查询会整层失效重拉，但重拉要时间，
   * 不先藏的话点完那一下它还在屏上停一瞬，像是没点上
   */
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set())
  const visible = items.filter((n) => !hidden.has(String(n.id)))
  if (visible.length === 0) return null

  function close(n: NoticeFeedItem) {
    const id = String(n.id)
    setHidden((prev) => new Set(prev).add(id))
    const notificationId = n.notification_id
    // 没有收件箱那一行的后端已经按已读给了，不会出现在横幅里；防一手
    if (notificationId == null) return
    // 🔴 原样传字符串，不要 `Number()`（硬纪律 6）
    markRead({ noticeId: id, notificationId }).catch((err: unknown) => {
      // 404 = 已经撤回 / 过期了，本来就该从横幅上消失（`isNoticeGone`），不是失败
      if (isNoticeGone(err)) return
      // 写失败：放回来（不然它悄悄消失、下次回前台又冒出来，读者以为点过了）+ toast（`src/components/` 分册「反馈」一节）
      setHidden((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      toast.error(t('没能标为已读'), { description: err instanceof Error ? err.message : String(err) })
    })
  }

  return (
    <View className="gap-2 px-4 pt-1" testID="home-notice-banner">
      {visible.map((n) => (
        <Pressable
          key={String(n.id)}
          // 🔴 ID 原样当字符串，不要 `Number()`（硬纪律 6）
          onPress={() => router.push({ pathname: '/notices/[id]', params: { id: String(n.id) } })}
          testID="home-notice-banner-item"
          // `active:` 必须写在 Pressable 自己身上（`src/components/` 分册），所以卡片表面也由它画
          className="bg-card active:bg-muted min-h-[52px] flex-row items-center gap-3 rounded-xl py-2 pr-1 pl-4"
        >
          <Icon as={MegaphoneIcon} className="text-destructive size-[18px]" />
          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold" numberOfLines={2}>
              {n.title}
            </Text>
            <Text className="text-muted-foreground font-mono text-[11px]">
              {t('紧急')} · {relativeTime(noticePublishedAt(n))}
            </Text>
            {n.require_ack ? (
              <Text className="text-muted-foreground text-[12px]">{t('点标题阅读并确认')}</Text>
            ) : null}
          </View>
          {n.require_ack ? (
            <View className="size-10 items-center justify-center">
              <Chevron icon={ChevronRightIcon} />
            </View>
          ) : (
            // 关掉 = 标已读。嵌在可点的整行里：RN 里里层的 Pressable 先拿到触摸，不会连带打开详情
            <Pressable
              onPress={() => close(n)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('知道了，不再显示')}
              testID="home-notice-banner-close"
              className="active:bg-muted size-10 items-center justify-center rounded-full"
            >
              <Icon as={XIcon} className="text-muted-foreground size-[18px]" />
            </Pressable>
          )}
        </Pressable>
      ))}
    </View>
  )
}
