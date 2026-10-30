import { Portal } from '@rn-primitives/portal'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, BackHandler, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { formatDateTime } from '@admin/i18n'

import { NoticeAttachments, NoticeLevelBadge, PinnedMark } from '@/components/notice'
import { RichText } from '@/components/rich-text'
import { Button } from '@/components/ui/button'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import type { NoticeFeedDetail } from '@/lib/contract'
import { isNoticeGone, noticePublishedAt, useMarkNoticeRead, useNoticePopups } from '@/lib/notices'

/**
 * 登录后弹窗（#190）。挂在已登录那棵树的根上（`(app)/_layout.tsx`），一条一条地弹。
 *
 * ## 呈现：portal 浮层，不是路由屏、也不是 RN 的 `Modal`
 *
 * - **不用 `Modal`**：和 `ui/confirm-dialog.tsx` 同一个理由 —— 它挂在另一个原生根上，那一类
 *   「样式在另一个原生根上失效」打包和 typecheck 都不报（`src/components/` 分册）。portal 那条路
 *   在 Android 上验收过（层级 · 返回键）
 * - **不做成路由屏**（`presentation: 'modal'`）：弹窗是「数据到了就出现」，要从一个后台查询里
 *   `router.push` 出去，还得管它和用户手上正在进行的导航谁先谁后；而且 iOS 的模态屏默认能下滑关掉，
 *   必须确认的那条要再去关 `gestureEnabled`。portal 浮层只是一层 View —— **没有任何手势能关掉它**，
 *   出口只有我们自己画的按钮和返回键（下面接了）
 *
 * ## 「必须确认」的只有一个出口
 *
 * `require_ack` → 只有「我已阅读」：遮罩点了不关、Android 返回键被吃掉。点了要**等标已读成功**
 * 才收起 —— 后端只认显式已读，没记下来就收起等于骗读者「已确认」；失败留在弹窗里（按钮下面一行红字），
 * 可以再点。否则「知道了」：当场收起、后台去标（遮罩和返回键也算「知道了」），失败走 toast。
 *
 * ## 拉取失败为什么不报（硬纪律 9 要一个理由）
 *
 * 弹窗**没有位置可占**（没东西要弹时它根本不存在），而它带的每一条在别处都有、且那些地方的失败是看得见的：
 * 首页「公告」组 / 通知屏（同一台服务器、同一个登录态，连不上时它们会报）；必须确认的那条在那里是未读，
 * 点进详情屏底部同样只有「我已阅读」。所以弹窗拉失败丢的是「主动弹出来」这个动作，不丢信息，也不丢确认。
 * 它自己会再试：查询的重试策略 + 每次回前台重拉（`useNoticePopups` 头注释）。
 * 反过来，给它配一条 toast 的话，离线时**每次打开 App** 都会冒一条，那是噪音。
 */
export function NoticePopups() {
  // 宿主一直挂着（弹窗收起只是子组件卸载），所以「知道了」失败时的回调里用这一份 `t` 没问题
  const { t } = useTranslation()
  const q = useNoticePopups()
  const { mutateAsync: markRead } = useMarkNoticeRead()
  /*
   * 这一次登录里已经处理过的（点了「知道了」/「我已阅读」）。
   *
   * 标已读成功后弹窗那个查询会被整层失效、重拉回来就没有它了 —— 但重拉要时间，不先从本地藏掉的话
   * 点完那一下同一条还会在屏上停一瞬。「知道了」标失败的那条也留在这里：不然它当场又弹回来，
   * 离线时就是一个关不掉的循环（下次登录 / 冷启动会再弹，那时候大概率已经能标上了）。
   */
  const [handled, setHandled] = React.useState<ReadonlySet<string>>(() => new Set())
  const markHandled = React.useCallback((id: string) => setHandled((prev) => new Set(prev).add(id)), [])

  const pending = (q.data ?? []).filter((n) => !handled.has(String(n.id)))
  const current = pending[0] ?? null
  if (!current) return null

  const id = String(current.id)
  const notificationId = current.notification_id

  return (
    <NoticePopup
      // 换一条就整块重挂：滚动位置、错误提示、附件下载状态都不该从上一条带过来
      key={id}
      notice={current}
      more={pending.length - 1}
      onDismiss={() => {
        markHandled(id)
        // 没有收件箱那一行的（#186 之前发的）后端已经按已读给了，不会出现在这里；防一手
        if (notificationId == null) return
        // 🔴 原样传字符串，不要 `Number()`（硬纪律 6）
        markRead({ noticeId: id, notificationId }).catch((err: unknown) => {
          // 404 = 这条已经撤回 / 过期了，没有东西可标（`isNoticeGone`），不算失败
          if (isNoticeGone(err)) return
          toast.error(t('没能标为已读'), { description: err instanceof Error ? err.message : String(err) })
        })
      }}
      onAcknowledge={async () => {
        if (notificationId != null) {
          try {
            await markRead({ noticeId: id, notificationId })
          } catch (err) {
            // 🔴 撤回 / 过期的那条标不上、也不用标 —— 不放行的话「我已阅读」永远 404，这个弹窗就关不掉了
            if (!isNoticeGone(err)) throw err
            toast.info(t('这条公告已撤回或已过期'))
          }
        }
        markHandled(id)
      }}
    />
  )
}

function NoticePopup({
  notice,
  more,
  onDismiss,
  onAcknowledge,
}: {
  notice: NoticeFeedDetail
  /** 这一条之后还排着几条 */
  more: number
  /** 「知道了」（以及不必确认时的遮罩 / 返回键） */
  onDismiss: () => void
  /** 「我已阅读」：resolve = 记下了，reject = 没记下 */
  onAcknowledge: () => Promise<void>
}) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  /*
   * 🔴 **portal 的 `name` 每实例唯一**（同名浮层互相顶掉，`src/components/` 分册）。
   * 一条处理完换下一条时 `key` 变了、整块重挂，新的 id 也就是新的 name
   */
  const portalName = `notice-popup-${React.useId()}`
  const mustAck = notice.require_ack
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function acknowledge() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onAcknowledge()
      // 成功之后父组件把这一条藏掉、本组件卸载 —— 后面不用再收拾状态
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  /*
   * 🔴 **Android 返回键要自己接**（portal 只是一层普通 View，返回键会直接把底下的屏 pop 掉）。
   *
   * ⚠️ 订阅只在挂上时登记一次，回调走 `useEffectEvent` 读最新的值。RN 的 `BackHandler`
   * 是**后登记的先收到**（`BackHandler.android.js` 从数组尾部往前调），而弹窗里还能打开图片附件的
   * 全屏查看（`attachment-list.tsx` 的 `ImagePreview`，它自己也接了返回键）—— 这里要是随渲染重新登记，
   * 就会排到查看层前面：按返回关掉的是弹窗（或者必须确认时被吞掉），图片关不上
   */
  const onBack = React.useEffectEvent(() => {
    if (!mustAck && !busy) onDismiss()
    // 一律返回 true：必须确认时吃掉返回键；不必确认时已经按「知道了」处理了
    return true
  })
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => onBack())
    return () => sub.remove()
  }, [])

  return (
    <Portal name={portalName}>
      <View
        className="absolute inset-0 z-40 items-center justify-center px-4"
        style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }}
        testID="notice-popup"
      >
        {/* 遮罩：必须确认的点了不关（只有「我已阅读」一个出口）；否则等同「知道了」 */}
        <Pressable
          className="absolute inset-0 bg-black/50"
          accessible={false}
          onPress={() => {
            if (!mustAck && !busy) onDismiss()
          }}
        />
        <View className="bg-background max-h-full w-full max-w-[480px] overflow-hidden rounded-2xl shadow-xl shadow-black/20">
          <View className="gap-1.5 px-5 pt-5 pb-3">
            <View className="flex-row items-center gap-2">
              {notice.pinned ? <PinnedMark /> : null}
              <NoticeLevelBadge level={notice.level} />
              <View className="flex-1" />
              {/* 后面还排着几条：不写的话点完一条又冒一条，像是关不掉 */}
              {more > 0 ? (
                <Text className="text-muted-foreground text-[11px]">{t('还有 {{n}} 条', { n: more })}</Text>
              ) : null}
            </View>
            <Text className="text-lg font-bold leading-6" testID="notice-popup-title">
              {notice.title}
            </Text>
            <Text className="text-muted-foreground font-mono text-[11px]">
              {t('发布于 {{at}}', { at: formatDateTime(noticePublishedAt(notice)) })}
            </Text>
          </View>

          {/*
            正文 + 附件在中间滚动，头和底部按钮不动。
            ⚠️ `flexGrow: 0` + `shrink`：外层只有 `max-h-full`、没有定高，ScrollView 默认的 flexGrow
            在这里没有可分的空间；内容超过屏高时靠 shrink 压到剩下的高度，短正文时弹窗就是内容那么高
          */}
          <ScrollView className="shrink" style={{ flexGrow: 0 }} contentContainerClassName="pb-3">
            <View className="bg-card mx-4 rounded-xl px-4 py-4">
              <RichText html={notice.content} testID="notice-popup-content" />
            </View>
            <NoticeAttachments noticeId={String(notice.id)} count={notice.attachment_count} />
          </ScrollView>

          <View className="border-border gap-2 border-t px-4 pt-3 pb-4">
            {mustAck ? (
              <Text className="text-muted-foreground text-[12px]">{t('发布方要求读完后确认')}</Text>
            ) : null}
            {error ? (
              // 失败留在弹窗里：这一条还没收起、按钮还能再点，错误就该挨着它（同附件行「失败留在那一行」）
              <View testID="notice-popup-error">
                <Text className="text-destructive text-[12px] font-medium">{t('没能标为已读')}</Text>
                <Text className="text-destructive text-[12px] leading-4">{error}</Text>
              </View>
            ) : null}
            <Button
              disabled={busy}
              onPress={mustAck ? () => void acknowledge() : onDismiss}
              testID={mustAck ? 'notice-popup-ack' : 'notice-popup-dismiss'}
              className="h-[48px] rounded-xl"
            >
              {busy ? <ActivityIndicator size="small" color="#fff" /> : null}
              <Text className="text-[15px] font-semibold">{mustAck ? t('我已阅读') : t('知道了')}</Text>
            </Button>
          </View>
        </View>
      </View>
    </Portal>
  )
}
