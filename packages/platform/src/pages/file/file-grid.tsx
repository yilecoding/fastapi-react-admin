import { useTranslation } from 'react-i18next'

import { Checkbox } from '@admin/ui/components/checkbox'
import { ContextMenu, ContextMenuTrigger } from '@admin/ui/components/context-menu'
import { cn } from '@admin/ui/lib/utils'

import { formatBytes, isPreviewable, type FileItem } from './api'
import { FileThumb } from './file-icon'
import { FileMenu, type FileActions } from './file-menu'

/**
 * 宫格视图 —— 文件管理的默认形态。
 *
 * 交互按「文件管理器」的习惯，而不是表格的习惯：
 * - **单击选中**（不是打开），再点取消
 * - **双击打开**（能预览的走预览，不能的走下载）
 * - **右键出菜单**
 *
 * 复选框常驻会让一屏几十个方框很吵，所以只在 hover / 聚焦 / 已选中时显形。
 */
export function FileGrid({
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
    <ul
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8"
      data-testid="file-grid"
    >
      {files.map((file) => {
        const isSelected = selected.has(file.id)
        return (
          <ContextMenu key={file.id}>
            <ContextMenuTrigger
              render={
                <li
                  // ⚠️ 卡片必须**定高**。不定高时，文件名换成两行的卡会比邻居高一截，
                  // 未选中看不出来（边框透明），一选中边框显形就是参差不齐的一排。
                  // group 让复选框能靠 group-hover 显形；min-w-0 防长文件名把格子顶开
                  className={cn(
                    'group relative flex h-[136px] min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-2.5 transition',
                    'hover:border-primary/40 hover:bg-accent/50',
                    isSelected ? 'border-primary bg-primary/5' : 'border-transparent bg-card'
                  )}
                  data-testid={`file-card-${file.id}`}
                  data-selected={isSelected}
                  onClick={() => onToggle(file.id)}
                  onDoubleClick={() =>
                    isPreviewable(file) ? actions.onPreview(file) : actions.onDownload(file)
                  }
                />
              }
            >
              {/* 缩略图槽位：给它一个浅色底 + 圆角，非图片文件的线框图标才不会
                  在一排实心缩略图中间显得空 —— 视觉重量对齐比图标本身更重要 */}
              <div className="flex h-[68px] w-full items-center justify-center overflow-hidden rounded-md bg-muted/40">
                <FileThumb file={file} />
              </div>

              {/* 名字区**定高两行**（h-8 = 2 × leading-tight），
                  这样体积那行在每张卡里都落在同一个 y 上。
                  一行截断太容易把有意义的部分切掉（`2026-Q3-报告.pdf`
                  这种前缀相同的名字，只看一行等于没看） */}
              <p
                className="line-clamp-2 h-8 w-full break-all text-center text-xs leading-tight"
                title={file.original_name}
              >
                {file.original_name}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">{formatBytes(file.size)}</p>

              <span
                className={cn(
                  'absolute start-2 top-2 transition-opacity',
                  isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                )}
                // 阻止冒泡：点复选框和点卡片是同一个动作（切换选中），
                // 不拦的话会触发两次、等于没切
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => onToggle(file.id)}
                  aria-label={t('选择 {{name}}', { name: file.original_name })}
                  data-testid={`file-check-${file.id}`}
                />
              </span>
            </ContextMenuTrigger>
            <FileMenu file={file} slot="context" actions={actions} />
          </ContextMenu>
        )
      })}
    </ul>
  )
}
