import { useLocalSearchParams } from 'expo-router'
import { MegaphoneOffIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ApiError } from '@admin/api'
import { formatDateTime } from '@admin/i18n'

import { NoticeAttachments, NoticeLevelBadge, PinnedMark } from '@/components/notice'
import { RichText } from '@/components/rich-text'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { noticePublishedAt, useMarkNoticeRead, useNoticeAttachments, useNoticeDetail } from '@/lib/notices'

/**
 * 公告详情（#186）。入口：首页「公告」组 · 通知屏里 `source = notice:<id>` 的那一行。
 *
 * 形状照 `users/[id].tsx`（详情屏的范式样板）：路径参数原样当字符串、三种失败分开。
 *
 * - 🔴 **404 是「已撤回或已过期」，不是「加载失败」。** 后端对隐藏 / 过期 / 删除一律 404
 *   （不区分，403 等于告诉对方「这条存在」）。渲染成「加载失败 + 重试」的话，读者会
 *   对着一个**永远不会成功**的重试按钮反复点。自然过期的公告收件箱那一行不会被撤回
 *   （没有事件可挂），所以从通知屏点进来撞上 404 是正常路径，不是边角
 * - 标已读放在**加载成功之后**：点进来就标、结果 404，等于把一条读者根本没看到的东西记成已读
 * - 🔴 **必须确认的（`require_ack`，#190）不自动标**，底部给「我已阅读」—— 后端对它只认显式已读，
 *   自动标掉就等于替读者点了确认
 */
export default function NoticeDetailScreen() {
  const { t } = useTranslation()
  const params = useLocalSearchParams<{ id: string | string[] }>()
  // expo-router 的参数不保证是单值（同名参数出现两次就是数组）。🔴 原样当字符串，不要 `Number()`
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '')

  const q = useNoticeDetail(id)
  const notice = q.data ?? null
  const hasAttachments = (notice?.attachment_count ?? 0) > 0
  // 附件区自己也挂着同一个 key（`NoticeAttachments`）；这里拿一份只为了下拉刷新时一起重拉
  const files = useNoticeAttachments(id, hasAttachments)
  const { mutate: markRead } = useMarkNoticeRead()
  // 「我已阅读」单独一个实例：要它自己的 `isPending` 给按钮转圈，和上面那个自动标的互不干扰
  const ack = useMarkNoticeRead()
  const insets = useSafeAreaInsets()

  /*
   * 打开成功就标已读，一次就够。
   *
   * ⚠️ 用 ref 记「这一屏标过了」：标完之后详情那份缓存改成 `read: true`，但失效收件箱
   * 会触发一串重渲染，`notice` 对象换了引用 —— 只靠 `notice.read` 判断的话，在缓存写回
   * 之前的那一帧里会再发一次（接口幂等，但白打一个请求）。
   * `notification_id` 为空 = 没有收件箱那一行（#186 之前发的），后端已经按已读给了。
   * `require_ack` 的跳过 —— 那一条要读者自己点底部的「我已阅读」
   */
  const marked = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!notice || notice.read || notice.require_ack || notice.notification_id == null || marked.current === id) return
    marked.current = id
    markRead({ noticeId: id, notificationId: notice.notification_id })
  }, [notice, id, markRead])

  if (q.isPending) {
    return (
      <View className="bg-background flex-1 gap-3 p-4">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </View>
    )
  }

  if (q.isError || notice === null) {
    return <DetailError error={q.error} onRetry={() => void q.refetch()} />
  }

  const notificationId = notice.notification_id
  // 必须确认、还没确认、而且有收件箱那一行可标（没有那一行的后端已经按已读给了，`read` 不会是 false）
  const needsAck = notice.require_ack && !notice.read && notificationId != null

  function acknowledge() {
    if (notificationId == null) return
    ack.mutate(
      { noticeId: id, notificationId },
      {
        // 成功之后详情那份缓存改成 `read: true`（`useMarkNoticeRead` 的 onSuccess），底部这一条随之收起
        onSuccess: () => toast.success(t('已确认阅读')),
        // 🔴 主动确认失败必须说：按钮还在、可以再点，但不说的话读者以为已经确认过了
        onError: (err) =>
          toast.error(t('没能标为已读'), { description: err instanceof Error ? err.message : String(err) }),
      },
    )
  }

  return (
    <View className="bg-background flex-1">
      <ScrollView
        className="bg-background flex-1"
        contentContainerClassName="pb-10"
        refreshControl={
          <RefreshControl
            refreshing={q.isRefetching || files.isRefetching}
            onRefresh={() => void Promise.all([q.refetch(), hasAttachments ? files.refetch() : null])}
          />
        }
      >
        <View className="gap-2 px-5 pt-4 pb-3">
          {notice.pinned || notice.level > 0 ? (
            <View className="flex-row items-center gap-2">
              {notice.pinned ? <PinnedMark /> : null}
              <NoticeLevelBadge level={notice.level} />
            </View>
          ) : null}
          <Text selectable className="text-xl font-bold leading-7" testID="notice-detail-title">
            {notice.title}
          </Text>
          {/* ⚠️ 服务端时间一律过 `@admin/i18n` 的 datetime 层（按账号的显示时区），不要裸打印 */}
          <View className="gap-0.5">
            {/* 文案 key 和 web 的公告详情共用一份（`发布于 {{at}}` / `{{at}} 过期`）。
                定时发布的那条「发布于」是到点的时间，不是建好的时间（#190） */}
            <Text className="text-muted-foreground font-mono text-[11px]">
              {t('发布于 {{at}}', { at: formatDateTime(noticePublishedAt(notice)) })}
            </Text>
            {notice.updated_time ? (
              <Text className="text-muted-foreground font-mono text-[11px]">
                {t('更新于 {{at}}', { at: formatDateTime(notice.updated_time) })}
              </Text>
            ) : null}
            {notice.expire_time ? (
              <Text className="text-muted-foreground font-mono text-[11px]">
                {t('{{at}} 过期', { at: formatDateTime(notice.expire_time) })}
              </Text>
            ) : null}
          </View>
        </View>

        <View className="bg-card mx-4 rounded-xl px-4 py-4">
          <RichText html={notice.content} testID="notice-detail-content" />
        </View>

        {/* 附件区（没有就整块不出、失败占住位置报出来 —— 规矩写在组件头注释里） */}
        <NoticeAttachments noticeId={id} count={notice.attachment_count} />
      </ScrollView>
      {needsAck ? (
        /*
          「我已阅读」钉在底部、不跟正文一起滚走：必须确认的公告往往很长，按钮放在正文末尾的话
          读者得先翻到底才知道这里要他做一件事。成功后这一条随 `read` 变真收起
        */
        <View
          className="bg-card border-border gap-2 border-t px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
          testID="notice-detail-ack"
        >
          <Text className="text-muted-foreground text-[12px]">{t('发布方要求读完后确认')}</Text>
          <Button
            disabled={ack.isPending}
            onPress={acknowledge}
            testID="notice-detail-ack-button"
            className="h-[50px] rounded-xl"
          >
            {ack.isPending ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text className="text-base font-semibold">{t('我已阅读')}</Text>
          </Button>
        </View>
      ) : null}
    </View>
  )
}

function DetailError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  if (error instanceof ApiError && error.httpStatus === 404) {
    return (
      <View className="bg-background flex-1 items-center justify-center gap-2 px-10" testID="notice-detail-gone">
        <Icon as={MegaphoneOffIcon} className="text-muted-foreground size-9" />
        <Text variant="small" className="text-muted-foreground">
          {t('这条公告已撤回或已过期')}
        </Text>
        <Text className="text-muted-foreground/70 text-center text-xs leading-5">
          {t('发布方已经把它收回，或者它过了有效期，正文和附件都看不到了。')}
        </Text>
      </View>
    )
  }
  return (
    <View className="bg-background flex-1 p-4">
      <Alert variant="destructive" icon={TriangleAlertIcon}>
        <AlertTitle>{t('公告拉取失败')}</AlertTitle>
        <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
        <Button variant="outline" size="sm" onPress={onRetry} className="mt-2 self-start">
          <Text>{t('重试')}</Text>
        </Button>
      </Alert>
    </View>
  )
}
