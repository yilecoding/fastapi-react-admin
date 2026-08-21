import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  IconFile,
  IconFileTypeCsv,
  IconFileTypeDocx,
  IconFileTypePdf,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFileZip,
  IconJson,
  IconMusic,
  IconPhoto,
  IconVideo,
} from '@tabler/icons-react'

import { cn } from '@admin/ui/lib/utils'

import { canThumbnail, fileThumbQuery, type FileItem, type FileType } from './api'

/** 扩展名 → 图标。命中不了的按大类回落，最后才是通用文件图标 */
const EXT_ICON: Record<string, typeof IconFile> = {
  pdf: IconFileTypePdf,
  doc: IconFileTypeDocx,
  docx: IconFileTypeDocx,
  rtf: IconFileTypeDocx,
  odt: IconFileTypeDocx,
  xls: IconFileTypeXls,
  xlsx: IconFileTypeXls,
  csv: IconFileTypeCsv,
  txt: IconFileTypeTxt,
  md: IconFileTypeTxt,
  log: IconFileTypeTxt,
  json: IconJson,
  xml: IconJson,
}

const TYPE_ICON: Record<FileType, typeof IconFile> = {
  image: IconPhoto,
  document: IconFile,
  video: IconVideo,
  audio: IconMusic,
  archive: IconFileZip,
  other: IconFile,
}

/** 各分类的图标着色 —— 一屏几十个文件时，颜色比形状更快区分 */
export const TYPE_TONE: Record<FileType, string> = {
  image: 'text-violet-500',
  document: 'text-sky-500',
  video: 'text-rose-500',
  audio: 'text-amber-500',
  archive: 'text-orange-500',
  other: 'text-muted-foreground',
}

export function fileIconOf(file: Pick<FileItem, 'ext' | 'type'>) {
  return EXT_ICON[file.ext.toLowerCase()] ?? TYPE_ICON[file.type] ?? IconFile
}

/** 纯图标（列表视图、附件面板用） */
export function FileTypeIcon({
  file,
  className,
}: {
  file: Pick<FileItem, 'ext' | 'type'>
  className?: string
}) {
  const Icon = fileIconOf(file)
  return <Icon className={cn('size-5 shrink-0', TYPE_TONE[file.type], className)} aria-hidden />
}

/**
 * 宫格里的缩略图：图片出真图，其余出类型图标。
 *
 * 三条约束合在一起决定了这个实现：
 *
 * 1. **不能用 `<img src={download_url}>`** —— 那个地址要 Authorization 头，
 *    裸 src 带不上，只会得到 401。所以必须取字节再转 blob URL。
 * 2. **必须懒加载** —— 一屏几十张图，进视区才取。用 IntersectionObserver；
 *    副作用是隐藏 tab（`display:none`）里永远不进视区，正好一个请求都不发。
 * 3. **blob URL 必须 revoke** —— 不 revoke 的话整张图的字节会挂在 document 上
 *    直到刷新页面，翻几页就是几百 MB。
 */
export function FileThumb({ file }: { file: FileItem }) {
  const [visible, setVisible] = React.useState(false)
  const ref = React.useRef<HTMLDivElement | null>(null)
  const wantThumb = canThumbnail(file)

  React.useEffect(() => {
    if (!wantThumb || visible) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      // 提前 200px 开始取，滚动时不会追着出现
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible, wantThumb])

  const { data } = useQuery({ ...fileThumbQuery(file), enabled: wantThumb && visible })

  // 从字节造 blob URL，并在卸载 / 换文件时收回
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!data) return
    const next = URL.createObjectURL(new Blob([data], { type: file.content_type ?? 'image/*' }))
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
      setUrl(null)
    }
  }, [data, file.content_type])

  const Icon = fileIconOf(file)

  return (
    <div ref={ref} className="flex size-full items-center justify-center overflow-hidden">
      {url ? (
        <img
          src={url}
          alt=""
          // 缩略图是装饰性的：alt 留空并 aria-hidden，文件名在下面那行已经念得到，
          // 读屏不需要在这里再听一次
          aria-hidden
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <Icon className={cn('size-10', TYPE_TONE[file.type])} aria-hidden />
      )}
    </div>
  )
}
