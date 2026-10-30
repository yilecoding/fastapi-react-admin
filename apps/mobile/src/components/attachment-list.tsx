import { Portal } from '@rn-primitives/portal'
import { StatusBar } from 'expo-status-bar'
import {
  ChevronRightIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ShareIcon,
  XIcon,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, BackHandler, Image, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Chevron, Group } from '@/components/grouped'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { downloadAttachment, formatBytes, isViewableImage, openWithSystem } from '@/lib/attachments'
import type { FileDetail } from '@/lib/contract'

/**
 * 公告详情的附件区：一行一个文件（类型图标 · 原文件名 · 大小）。
 *
 * 点一下：带鉴权下载到缓存目录 → 能画的图片在屏里看，其余交给系统分享面板
 * （为什么这么分、为什么不在 App 里预览 PDF，见 `lib/attachments.ts`）。
 *
 * 每行自己的状态：下载中（百分比 / 转圈，整行禁用）· 失败（红字留在那一行，再点重试）。
 * 🔴 **失败留在行上，不走 toast**：一条公告常挂好几个文件，toast 飘走之后读者分不清
 * 是哪个没打开；而且那一行本来就是这个动作的位置（`src/components/` 分册「反馈」一节
 * 的「占住它的位置」）。
 */

type RowState = { phase: 'downloading'; ratio: number | null } | { phase: 'error'; message: string }

const DOC_SHEET_EXT = new Set(['xls', 'xlsx', 'csv', 'et', 'numbers'])

function iconFor(file: FileDetail) {
  switch (file.type) {
    case 'image':
      return FileImageIcon
    case 'video':
      return FileVideoIcon
    case 'audio':
      return FileAudioIcon
    case 'archive':
      return FileArchiveIcon
    case 'document':
      return DOC_SHEET_EXT.has(file.ext.toLowerCase()) ? FileSpreadsheetIcon : FileTextIcon
    default:
      return FileIcon
  }
}

export function AttachmentList({ files }: { files: FileDetail[] }) {
  const { t } = useTranslation()
  const [rows, setRows] = React.useState<Record<string, RowState>>({})
  const [preview, setPreview] = React.useState<{ uri: string; file: FileDetail } | null>(null)
  const controllers = React.useRef(new Map<string, AbortController>())

  // 离开这一屏就把还在下的取消掉 —— 不然原生层还在写缓存，回调回来改一个已经卸载的组件
  React.useEffect(() => {
    const map = controllers.current
    return () => {
      for (const c of map.values()) c.abort()
      map.clear()
    }
  }, [])

  const setRow = (id: string, state: RowState | null) =>
    setRows((prev) => {
      const next = { ...prev }
      if (state) next[id] = state
      else delete next[id]
      return next
    })

  async function open(file: FileDetail) {
    const id = String(file.id)
    if (controllers.current.has(id)) return // 同一个文件在下了，别连发
    const ctrl = new AbortController()
    controllers.current.set(id, ctrl)
    setRow(id, { phase: 'downloading', ratio: null })
    try {
      const uri = await downloadAttachment(file, {
        signal: ctrl.signal,
        onProgress: (ratio) => setRow(id, { phase: 'downloading', ratio }),
      })
      // 下完就把行放开 —— 分享面板的 Promise 要等用户从别的 App 回来才结束，
      // 行一直转圈会让人以为卡住了
      setRow(id, null)
      if (isViewableImage(file)) setPreview({ uri, file })
      else await openWithSystem(uri, file)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setRow(id, { phase: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      controllers.current.delete(id)
    }
  }

  async function shareFromPreview() {
    if (!preview) return
    const { uri, file } = preview
    try {
      await openWithSystem(uri, file)
    } catch (err) {
      setPreview(null)
      setRow(String(file.id), { phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <>
      <Group>
        {files.map((f, i) => {
          const id = String(f.id)
          const state = rows[id]
          const busy = state?.phase === 'downloading'
          return (
            <React.Fragment key={id}>
              {i === 0 ? null : <View className="bg-border h-px" style={{ marginLeft: 56 }} />}
              <Pressable
                onPress={() => void open(f)}
                disabled={busy}
                testID="notice-attachment-row"
                accessibilityState={{ busy, disabled: busy }}
                className="active:bg-muted min-h-[54px] flex-row items-center gap-3 px-5 py-2.5"
              >
                <Icon as={iconFor(f)} className="text-muted-foreground size-[22px]" />
                <View className="flex-1 gap-0.5">
                  <Text className="text-[15px]" numberOfLines={2}>
                    {f.original_name}
                  </Text>
                  {state?.phase === 'error' ? (
                    <Text className="text-destructive text-[12px] leading-4" numberOfLines={3}>
                      {state.message}
                    </Text>
                  ) : (
                    <Text className="text-muted-foreground font-mono text-[11px]">
                      {busy ? t('正在下载…') : formatBytes(f.size)}
                    </Text>
                  )}
                </View>
                {busy ? (
                  state.ratio === null ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text className="text-muted-foreground font-mono text-[12px]">{Math.round(state.ratio * 100)}%</Text>
                  )
                ) : (
                  <Chevron icon={ChevronRightIcon} />
                )}
              </Pressable>
            </React.Fragment>
          )
        })}
      </Group>
      {preview ? (
        <ImagePreview
          uri={preview.uri}
          name={preview.file.original_name}
          onClose={() => setPreview(null)}
          onShare={() => void shareFromPreview()}
        />
      ) : null}
    </>
  )
}

/**
 * 图片附件的全屏查看。黑底 + 等比缩放 + 顶部一条（关闭 · 文件名 · 用其他应用打开）。
 *
 * 和 `ui/confirm-dialog.tsx` 同一条路：**走 portal 不走 `Modal`**（`Modal` 挂在另一个原生
 * 根上，那一类样式失效打包和 typecheck 都不报），代价是 Android 返回键要自己接 ——
 * 不接的话按返回会把底下的详情屏 pop 掉、查看层还开着。
 * portal 的 `name` 每实例唯一（同名浮层互相顶掉）。
 */
function ImagePreview({
  uri,
  name,
  onClose,
  onShare,
}: {
  uri: string
  name: string
  onClose: () => void
  onShare: () => void
}) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const portalName = `image-preview-${React.useId()}`

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => sub.remove()
  }, [onClose])

  return (
    <Portal name={portalName}>
      <View
        className="absolute inset-0 z-40 bg-black"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        testID="attachment-image-preview"
      >
        {/* 黑底上状态栏要用浅色字，否则浅色主题下时间和电量隐形 */}
        <StatusBar style="light" />
        <View className="flex-row items-center gap-1 px-1 py-1">
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('关闭')}
            className="size-11 items-center justify-center rounded-full active:bg-white/15"
          >
            <Icon as={XIcon} className="size-6 text-white" />
          </Pressable>
          <Text className="flex-1 text-[15px] text-white" numberOfLines={1}>
            {name}
          </Text>
          <Pressable
            onPress={onShare}
            accessibilityRole="button"
            accessibilityLabel={t('用其他应用打开')}
            className="size-11 items-center justify-center rounded-full active:bg-white/15"
          >
            <Icon as={ShareIcon} className="size-5 text-white" />
          </Pressable>
        </View>
        <Image source={{ uri }} resizeMode="contain" accessibilityLabel={name} style={{ flex: 1 }} />
      </View>
    </Portal>
  )
}
