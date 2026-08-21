import { useTranslation } from 'react-i18next'
import { IconDownload, IconEye, IconInfoCircle, IconTrash } from '@tabler/icons-react'

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@admin/ui/components/context-menu'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@admin/ui/components/dropdown-menu'

import { Can } from '../../auth/can'
import { isPreviewable, type FileItem } from './api'

export type FileActions = {
  onPreview: (f: FileItem) => void
  onDownload: (f: FileItem) => void
  onDetail: (f: FileItem) => void
  onDelete: (f: FileItem) => void
}

type Slot = 'context' | 'dropdown'

/**
 * 文件操作菜单。同一份条目要出现在两个地方 —— 右键（宫格/列表行）和
 * 行尾的 ⋯ 下拉。两套组件的 Content/Item 不能混用（Base UI 各有自己的
 * context），所以按 `slot` 切换外壳，条目定义只写一遍。
 *
 * 不做「重命名」：`sys_file.original_name` 改了之后，已经挂出去的附件、
 * 已经发出去的下载链接指向的还是同一条记录，改名不影响它们 —— 但后端目前
 * 没有 update 接口，加之前先想清楚要不要允许改（ContiNew Admin 有 rename，
 * 我们这版刻意没有，别照着抄一个只改前端的假功能）。
 */
export function FileMenu({
  file,
  slot,
  actions,
}: {
  file: FileItem
  slot: Slot
  actions: FileActions
}) {
  const { t } = useTranslation()
  const Content = slot === 'context' ? ContextMenuContent : DropdownMenuContent
  const Item = slot === 'context' ? ContextMenuItem : DropdownMenuItem
  const Sep = slot === 'context' ? ContextMenuSeparator : DropdownMenuSeparator

  return (
    <Content align="start" className="w-40">
      {isPreviewable(file) && (
        <Item onClick={() => actions.onPreview(file)} data-testid={`file-preview-${file.id}`}>
          <IconEye className="size-4" />
          {t('预览')}
        </Item>
      )}
      <Item onClick={() => actions.onDownload(file)} data-testid={`file-download-${file.id}`}>
        <IconDownload className="size-4" />
        {t('下载')}
      </Item>
      <Item onClick={() => actions.onDetail(file)} data-testid={`file-detail-${file.id}`}>
        <IconInfoCircle className="size-4" />
        {t('详情')}
      </Item>
      <Can perm="sys:file:del">
        <Sep />
        <Item
          variant="destructive"
          onClick={() => actions.onDelete(file)}
          data-testid={`file-delete-${file.id}`}
        >
          <IconTrash className="size-4" />
          {t('删除')}
        </Item>
      </Can>
    </Content>
  )
}
