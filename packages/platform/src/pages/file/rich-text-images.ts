import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import type { RichTextImages } from '@admin/ui/components/rich-text'

import { usePerm } from '../../auth/use-perm'
import { INLINE_IMAGE_MAX_BYTES, fileKeys, uploadInlineImage } from './api'

/**
 * 把「文件上传」接到富文本编辑器上。
 *
 * 为什么要这么一层：编辑器住在 `packages/ui`，而上传要 api-client ——
 * 而 `ui` 永远不 import `platform`（依赖方向单向）。所以能力由这一层注入。
 *
 * ```tsx
 * const images = useRichTextImages()
 * <RichTextEditor value={v} onChange={setV} images={images} />
 * ```
 *
 * 不传 `images` 的话编辑器整块关掉图片功能（沙箱 demo 就是这样），
 * 而不是给一个点了报错的按钮。
 */
export function useRichTextImages(): RichTextImages {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { can } = usePerm()
  const canUpload = can('sys:file:upload')

  return React.useMemo<RichTextImages>(
    () => ({
      upload: async (file) => {
        /**
         * 权限不够时**抛错**，而不是把按钮藏起来。
         *
         * 藏按钮会让粘贴路径变成静默失败：粘一张截图，什么都不发生，
         * 用户以为是自己操作错了（硬纪律 9 —— 请求失败必须是可见状态，
         * 不是缺失状态）。这里先在前端拦一次只是为了给一句人话；
         * 真正的拦截在后端 `RequestPermission('sys:file:upload')`。
         */
        if (!canUpload) {
          throw new Error(t('没有上传文件的权限（sys:file:upload）'))
        }

        const saved = await uploadInlineImage(file)

        // 内联图也是 `sys_file` 里的一条记录，会出现在「文件管理」和存储统计里。
        // 不失效的话那两处要等下次进页面才看得到，容易让人以为图没传上去
        void qc.invalidateQueries({ queryKey: fileKeys.all })

        if (!saved.public_url) {
          // 走到这里说明后端收下了文件但没给直链 —— 多半是 `is_public` 没落上，
          // 或者 `/uploads` 挂载没生效。**不能**回落到 download_url：
          // 那个地址要 Authorization 头，塞进 <img src> 就是一张裂图 + 一行 401，
          // 而症状会被误判成「上传坏了」
          throw new Error(t('上传成功但没有拿到直链，请检查后端 /uploads 挂载'))
        }

        return {
          src: saved.public_url,
          // 雪花字符串，不要 Number()（硬纪律 6）
          fileId: saved.id,
          // 原始文件名当 alt 的默认值：比空 alt 有用，读屏至少能念出「这是什么图」
          alt: saved.original_name,
        }
      },
      maxBytes: INLINE_IMAGE_MAX_BYTES,
    }),
    [canUpload, qc, t]
  )
}
