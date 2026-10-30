import { useLocalSearchParams } from 'expo-router'
import { MegaphoneOffIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import { ApiError } from '@admin/api'
import { formatDateTime } from '@admin/i18n'

import { AttachmentList } from '@/components/attachment-list'
import { GroupHeader } from '@/components/grouped'
import { NoticeLevelBadge, PinnedMark } from '@/components/notice'
import { RichText } from '@/components/rich-text'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { useMarkNoticeRead, useNoticeAttachments, useNoticeDetail } from '@/lib/notices'

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
 */
export default function NoticeDetailScreen() {
  const { t } = useTranslation()
  const params = useLocalSearchParams<{ id: string | string[] }>()
  // expo-router 的参数不保证是单值（同名参数出现两次就是数组）。🔴 原样当字符串，不要 `Number()`
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '')

  const q = useNoticeDetail(id)
  const notice = q.data ?? null
  const hasAttachments = (notice?.attachment_count ?? 0) > 0
  const files = useNoticeAttachments(id, hasAttachments)
  const { mutate: markRead } = useMarkNoticeRead()

  /*
   * 打开成功就标已读，一次就够。
   *
   * ⚠️ 用 ref 记「这一屏标过了」：标完之后详情那份缓存改成 `read: true`，但失效收件箱
   * 会触发一串重渲染，`notice` 对象换了引用 —— 只靠 `notice.read` 判断的话，在缓存写回
   * 之前的那一帧里会再发一次（接口幂等，但白打一个请求）。
   * `notification_id` 为空 = 没有收件箱那一行（#186 之前发的），后端已经按已读给了。
   */
  const marked = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!notice || notice.read || notice.notification_id == null || marked.current === id) return
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

  const fileList = files.data ?? null

  return (
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
          {/* 文案 key 和 web 的公告详情共用一份（`发布于 {{at}}` / `{{at}} 过期`） */}
          <Text className="text-muted-foreground font-mono text-[11px]">
            {t('发布于 {{at}}', { at: formatDateTime(notice.created_time) })}
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

      {/*
        附件区：没有附件整块不出（读者不需要看到「暂无附件」）。
        个数以列表为准 —— 后端只列这个人读得了的，可能比 `attachment_count` 少；
        列表拉回来是空的也整块收起。拉取失败要**占住位置**报出来（硬纪律 9）：
        否则读者看到的是「这条没有附件」，而列表页上明明有 📎。
      */}
      {hasAttachments && !(fileList && fileList.length === 0) ? (
        <>
          <GroupHeader>{t('附件（{{n}}）', { n: fileList?.length ?? notice.attachment_count })}</GroupHeader>
          {files.isError ? (
            <View className="px-4">
              <Alert variant="destructive" icon={TriangleAlertIcon}>
                <AlertTitle>{t('附件加载失败')}</AlertTitle>
                <AlertDescription>
                  {files.error instanceof Error ? files.error.message : String(files.error)}
                </AlertDescription>
                <Button variant="outline" size="sm" onPress={() => void files.refetch()} className="mt-2 self-start">
                  <Text>{t('重试')}</Text>
                </Button>
              </Alert>
            </View>
          ) : fileList === null ? (
            <View className="gap-2 px-4">
              <Skeleton className="h-[54px] rounded-xl" />
            </View>
          ) : (
            <AttachmentList files={fileList} />
          )}
        </>
      ) : null}
    </ScrollView>
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
