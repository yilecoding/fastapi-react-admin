import { useQueryClient } from '@tanstack/react-query'

import { api, uploadFile } from '../../api-client/client'
import { sha256File, useUploader, type UploadItem, type Uploader } from '../../upload'
import { fileKeys, type FileItem } from './api'

/**
 * 文件管理 / 附件面板共用的上传器：把 `upload/` 那个不认识接口的队列接到 `/sys/files/*` 上。
 *
 * 每个文件三步：浏览器端算 sha256 → `GET /sys/files/check`（同一人 + 同名 + 同内容传过就**不传**，
 * 直接拿旧记录）→ `POST /sys/files/upload`（XHR，有进度、可取消）。
 * 秒传预检之前这里是「先把整个文件传上去、后端算完 sha256 再发现重复」—— 99 MB 的 zip 重复传一次
 * 就是 99 MB 白跑，而且界面上什么都不说。
 *
 * ⚠️ `public` 只给富文本内联图那条路（落无鉴权的 `/uploads` 子树）；文件页和附件面板都不传。
 * `/check` 的 `public` 要和上传的一致，否则「check 说命中了、upload 还是重传一份」。
 */
export function useFileUploader(options: { public?: boolean; onDone?: (item: UploadItem<FileItem>) => void } = {}): Uploader<FileItem> {
  const qc = useQueryClient()
  const isPublic = options.public ?? false
  const qs = isPublic ? '?public=true' : ''

  return useUploader<FileItem>(
    {
      hash: (file, ctx) => sha256File(file, { signal: ctx.signal, onProgress: ctx.onProgress }),
      check: async (file, sha256) => {
        const params = new URLSearchParams({ sha256, name: file.name })
        if (isPublic) params.set('public', 'true')
        // 接口对「没传过」返回 data: null（success），不是 fail —— 首次上传不是错误
        return api.GET<FileItem | null>(`/api/v1/sys/files/check?${params.toString()}`)
      },
      upload: (file, ctx) =>
        uploadFile<FileItem>(`/api/v1/sys/files/upload${qs}`, file, 'file', {
          signal: ctx.signal,
          onProgress: ctx.onBytes,
        }),
    },
    {
      onDone: (item) => {
        // 秒传命中时列表里本来就有那条，刷新也无妨；真上传了就必须刷新
        void qc.invalidateQueries({ queryKey: fileKeys.all })
        options.onDone?.(item)
      },
    },
  )
}
