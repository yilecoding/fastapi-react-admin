import { useTranslation } from 'react-i18next'
import { IconDotsVertical } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { ContextMenu, ContextMenuTrigger } from '@admin/ui/components/context-menu'
import { DropdownMenu, DropdownMenuTrigger } from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { FILE_TYPE_LABEL, formatBytes, isPreviewable, type FileItem } from './api'
import { FileTypeIcon } from './file-icon'
import { FileMenu, type FileActions } from './file-menu'

/**
 * 列表视图。
 *
 * **手写的行，不是 `DataTable`。** 表格是给多行同构数据做对齐扫描用的，
 * 而文件列表的主体是「一个名字 + 几个次要属性」——
 * 用表格会得到七列等宽表头（分类/格式/大小/上传时间/校验和…），
 * 最该看的文件名被挤在第一列里，一屏能看的文件数还少一半。
 * 这里让文件名吃掉剩余宽度，其余属性靠右排成一条次要信息带。
 *
 * 交互与宫格保持一致：单击选中 · 双击打开 · 右键菜单。
 */
export function FileList({
  files,
  selected,
  onToggle,
  actions,
}: {
  files: FileItem[]
  selected: Set<string>
  onToggle: (id: string) => void
  actions: FileActions
}) {
  const { t } = useTranslation()

  return (
    <ul className="flex flex-col divide-y rounded-lg border" data-testid="file-list">
      {files.map((file) => {
        const isSelected = selected.has(file.id)
        return (
          <ContextMenu key={file.id}>
            <ContextMenuTrigger
              render={
                <li
                  className={cn(
                    'group flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2 transition',
                    'hover:bg-accent/50',
                    isSelected && 'bg-primary/5'
                  )}
                  data-testid={`file-row-${file.id}`}
                  data-selected={isSelected}
                  onClick={() => onToggle(file.id)}
                  onDoubleClick={() =>
                    isPreviewable(file) ? actions.onPreview(file) : actions.onDownload(file)
                  }
                />
              }
            >
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => onToggle(file.id)}
                  aria-label={t('选择 {{name}}', { name: file.original_name })}
                  data-testid={`file-check-${file.id}`}
                />
              </span>

              <FileTypeIcon file={file} />

              {/* min-w-0 + flex-1 让名字吃掉剩余宽度而不是撑破整行
                  （`w-full` 在有兄弟元素的 flex 行里必定溢出） */}
              <span className="min-w-0 flex-1 truncate text-sm" title={file.original_name}>
                {file.original_name}
              </span>

              <Badge variant="outline" className="hidden shrink-0 font-normal sm:inline-flex">
                {t(FILE_TYPE_LABEL[file.type] ?? '其他')}
              </Badge>
              <span className="hidden w-16 shrink-0 text-end text-xs tabular-nums text-muted-foreground sm:inline">
                {formatBytes(file.size)}
              </span>
              <span className="hidden w-36 shrink-0 text-end text-xs tabular-nums text-muted-foreground md:inline">
                {formatDateTime(file.created_time)}
              </span>

              <span onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('操作 {{name}}', { name: file.original_name })}
                      />
                    }
                    data-testid={`file-actions-${file.id}`}
                  >
                    <IconDotsVertical className="size-4" />
                  </DropdownMenuTrigger>
                  <FileMenu file={file} slot="dropdown" actions={actions} />
                </DropdownMenu>
              </span>
            </ContextMenuTrigger>
            <FileMenu file={file} slot="context" actions={actions} />
          </ContextMenu>
        )
      })}
    </ul>
  )
}
