import { resolveEnvelope } from '@admin/api'
import { t } from '@admin/i18n'
import * as ImagePicker from 'expo-image-picker'

import { api } from '@/lib/api'
import { serverStore } from '@/lib/server'

/**
 * 头像：从相册选一张 → 传到公开子树 → 拼成绝对地址 → 写回 `PUT /users/me/avatar`。
 * 形状照 web 的 `platform/src/pages/profile/api.ts: useUploadAvatar` 抄，三条约束一样：
 *
 * - 🔴 **必须 `?public=true`**：头像最终进 `<Image source>`，而私有文件的下载地址
 *   要 Authorization 头，带不上就是一张裂图。公开子树挂在后端 `/uploads`，不鉴权
 * - 🔴 **拿不到 `public_url` 就报错，不能回落到下载地址**（同上，那是一张裂图）
 * - ⚠️ **存的是绝对地址**：后端 `avatar` 是 `HttpUrl`，只收完整地址，而 `public_url`
 *   是相对路径。拼的是**当前服务器地址**（`serverStore`，用户在设置里能改）——
 *   换服务器地址之后旧头像会失效，和 web 换 API 主机名同一个代价
 */

/** 与 web 同值：服务端才是权威（`UPLOAD_IMAGE_SIZE_MAX`），这里只为别把注定被拒的字节先传一遍 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

type UploadedImage = { id: string; public_url: string | null }

/**
 * 打开系统相册。用户取消返回 `null`。
 *
 * ⚠️ 不先 `requestMediaLibraryPermissionsAsync()`：`launchImageLibraryAsync` 在 Android 13+
 * 走系统的照片选择器、iOS 14+ 走 PHPicker，**都不需要相册权限**。先请求权限反而会
 * 多弹一次授权框，而用户拒绝之后这里就没法再选了。
 */
export async function pickAvatar(): Promise<ImagePicker.ImagePickerAsset | null> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    // 头像是方的：让用户自己裁，而不是上传之后被圆形头像裁掉一半脸
    allowsEditing: true,
    aspect: [1, 1],
    // 手机原图动辄 5MB+，压一下基本都能落进 2MB
    quality: 0.7,
  })
  if (res.canceled) return null
  return res.assets[0] ?? null
}

export async function uploadAvatar(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  // `fileSize` 在部分 Android 机型上拿不到（undefined），拿不到就交给服务端判
  if (asset.fileSize && asset.fileSize > AVATAR_MAX_BYTES) {
    throw new Error(t('图片超过 {{n}} MB，换一张小一点的', { n: AVATAR_MAX_BYTES / 1024 / 1024 }))
  }

  // 🔴 后端**只按文件名的扩展名**判类型（`file_ops.upload_file_verify`），不看 MIME。
  // 所以文件名按 MIME 现生成，不用 `asset.fileName`：iOS 相册原名常是 `IMG_0001.HEIC`
  // （不在白名单里），安卓裁剪之后它又可能是 null。
  const mime = asset.mimeType ?? 'image/jpeg'
  const ext = EXT_BY_MIME[mime]
  if (!ext) {
    // 不能硬起一个 `.jpg` 的名字蒙混过去 —— 后端会收，但 HEIC 内容进了 `<img>` 就是裂图
    throw new Error(t('不支持这种图片格式（{{mime}}），换一张 JPG / PNG / WebP', { mime }))
  }

  const form = new FormData()
  // RN 的 FormData 收的是 `{ uri, name, type }` 描述对象，不是 Blob —— 原生层按 uri 读文件
  form.append('file', { uri: asset.uri, name: `avatar.${ext}`, type: mime } as unknown as Blob)

  const res = await api.sendRaw('POST', '/api/v1/sys/files/upload?public=true', form, 'application/json')
  // 🔴 成功路径也要过信封：FBA 的 `fail()` 是 HTTP 200 + `code: 400`，只看 `res.ok` 会把被拒的上传当成功
  const outcome = resolveEnvelope<UploadedImage>(res, await res.json().catch(() => null))
  if (!outcome.ok) throw outcome.error
  if (!outcome.data.public_url) {
    throw new Error(t('上传成功但没有拿到直链，请检查后端 /uploads 挂载'))
  }

  const url = `${serverStore.current()}${outcome.data.public_url}`
  await api.PUT('/api/v1/sys/users/me/avatar', { body: { avatar: url } })
  return url
}

/** 后端 `UPLOAD_IMAGE_EXT_INCLUDE` 里浏览器和 RN 都能渲染的那几种 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
