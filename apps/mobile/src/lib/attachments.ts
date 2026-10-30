import { currentLanguage, t } from '@admin/i18n'
import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'

import { api } from '@/lib/api'
import type { FileDetail } from '@/lib/contract'
import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

/**
 * 附件：带鉴权下载到缓存目录 → 图片在屏里看、其余交给系统分享面板（#186）。
 *
 * ## 为什么是「下载 + 系统分享面板」，不是在 App 里预览
 *
 * - Android 的 WebView 不渲染 PDF；App 里自己渲染要装 `react-native-pdf` 这类原生模块，
 *   **Expo Go 里没有** —— 会断掉本仓库赖以调试的那条路（`apps/mobile/AGENTS.md`「版本」一节）
 * - 浏览器打开预签名地址也不行：本地存储的 `/link` 返回 `null`
 * - Office 文件反正只能交给外部应用
 *
 * 所以 PDF / Office / 压缩包交给系统（WPS、系统 PDF 阅读器、微信……），用户自己选。
 * `expo-file-system` 和 `expo-sharing` 都在 Expo Go（SDK 57）里 —— 实测：Expo Go 57.0.9 的
 * APK 里有 `expo/modules/sharing/SharingModule`、`SharingFileProvider`、
 * `expo/modules/filesystem/FileSystemModule` 这几个类。
 *
 * ## 🔴 下载接口要 Authorization 头，裸地址是 401
 *
 * 原生下载（Android 上是 expo-file-system **自己的** OkHttpClient，不是 RN 的网络栈）
 * 不经过 `@admin/api`，所以 401 单飞刷新也不经过它。办法是**先用共享客户端问一次
 * `GET /sys/files/{pk}`**：
 *
 * - access token 过期了，就在这一步按共享那套刷新掉（刷不回来照常弹回登录屏）
 * - 它和下载走的是**同一个读权限判断**（`file_service.get_readable` / `resolve`，
 *   后端 #186 让它跟着公告的可见性走）—— 公告刚被撤回，这里就是一条看得懂的 404，
 *   而不是原生层的一句 `response has status: 404`
 *
 * 之后再拿内存里那枚（刚确认过的）token 去下。两步之间只差几毫秒。
 *
 * ## 🔴 文件名用 `original_name`，不用响应头
 *
 * 后端 `Content-Disposition` 的 ASCII 兜底会把中文去掉（实测 `filename="-e302….pdf"`）。
 * 分享出去的文件名就是对方 App 里看到的名字，所以本地文件按原名起。
 */

/** 和 web 的 `pages/file/api.ts: formatBytes` 同一个口径 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  // 小于 10 给一位小数，大于 10 取整 —— `1.2 MB` 有用，`123.4 MB` 那位小数是噪音
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value))
  return `${shown} ${units[i]}`
}

/** RN 的 `<Image>` 两端都能画的格式。HEIC / BMP / TIFF / SVG 交给系统 */
const VIEWABLE_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

export function isViewableImage(file: Pick<FileDetail, 'ext'>): boolean {
  return VIEWABLE_IMAGE_EXT.has(file.ext.toLowerCase().replace(/^\./, ''))
}

/**
 * 本地文件名。原名里可能有路径分隔符和各家文件系统不收的字符（`/` 在 Android 上会被当成
 * 子目录，下载直接失败），一律换成 `_`；太长的截断但保住扩展名 ——
 * 对方 App 靠扩展名认类型，丢了扩展名 WPS 会说「不支持的文件」。
 */
export function localFileName(file: Pick<FileDetail, 'original_name' | 'ext'>): string {
  const ext = file.ext.toLowerCase().replace(/^\./, '')
  // eslint-disable-next-line no-control-regex
  let name = file.original_name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim()
  name = name.replace(/^\.+/, '') // 隐藏文件 / `..`
  if (!name) name = 'file'
  if (ext && !name.toLowerCase().endsWith(`.${ext}`)) name = `${name}.${ext}`
  if (name.length > 120) {
    const tail = ext ? `.${ext}` : ''
    name = `${name.slice(0, 120 - tail.length)}${tail}`
  }
  return name
}

/**
 * 下载到缓存目录，返回本地 `file://` 地址。
 *
 * 同一个文件下过一次就直接用缓存（文件内容跟 ID 绑定，不会变）—— 但**权限照样先问**：
 * 公告撤回之后，缓存里那份也不该再打开。
 *
 * `onProgress` 收 0–1；服务端没给长度时是 `null`（界面显示转圈而不是百分比）。
 */
export async function downloadAttachment(
  file: FileDetail,
  options: { onProgress?: (ratio: number | null) => void; signal?: AbortSignal } = {},
): Promise<string> {
  // 🔴 先过共享客户端：刷新 token + 同一套读权限（见文件头）。`pk` 原样传字符串
  const fresh = await api.GET('/api/v1/sys/files/{pk}', { params: { path: { pk: file.id } } })

  // 每个文件一个子目录：两个附件重名（「通知.pdf」）时不会互相覆盖
  const dir = new Directory(Paths.cache, 'attachments', String(file.id))
  dir.create({ intermediates: true, idempotent: true })
  const dest = new File(dir, localFileName(fresh))

  if (dest.exists && dest.size === fresh.size) return dest.uri

  const token = tokenStore.get()
  const headers: Record<string, string> = { 'Accept-Language': currentLanguage() }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const out = await File.downloadFileAsync(`${serverStore.current()}${fresh.download_url}`, dest, {
      headers,
      // 上次下到一半的残片在这里被覆盖掉
      idempotent: true,
      signal: options.signal,
      onProgress: (p) => options.onProgress?.(p.totalBytes > 0 ? Math.min(1, p.bytesWritten / p.totalBytes) : null),
    })
    return out.uri
  } catch (err) {
    // 下到一半的残片删掉，否则它会一直占着缓存（大小对不上，不会被当成缓存命中）
    try {
      if (dest.exists) dest.delete()
    } catch {
      // 删不掉就算了，下次 idempotent 覆盖
    }
    if (err instanceof Error && err.name === 'AbortError') throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(t('下载失败：{{reason}}', { reason }), { cause: err })
  }
}

/**
 * 交给系统分享面板（「用其他应用打开」）。
 *
 * ⚠️ Android 上要带 `mimeType`：不带的话 expo-sharing 按文件名猜，猜不出来就是 `*\/*`，
 * 面板里会混进一堆不相干的应用。老记录的 `content_type` 可能是空的，那时才交给它猜。
 */
export async function openWithSystem(uri: string, file: Pick<FileDetail, 'original_name' | 'content_type'>) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(t('这台设备上没有能打开文件的应用'))
  }
  await Sharing.shareAsync(uri, {
    mimeType: file.content_type || undefined,
    dialogTitle: file.original_name,
  })
}
