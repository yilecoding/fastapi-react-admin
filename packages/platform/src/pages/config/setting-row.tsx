import { IconDeviceDesktop, IconDotsVertical, IconPencil, IconTrash } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import type { ConfigItem } from './api'
import { metaOf } from './registry'
import { ValueEditor } from './value-editor'

/**
 * 一条设置 = 「左边说清楚是什么，右边一个控件」。
 *
 * 这是从表格换过来的关键一步：表格是给多行**同构**数据用的，
 * 而设置项是一堆异构的单值 —— 用表格会迫使人横向扫 6 列，
 * 而且最该读的那句说明（「0 表示禁用锁定」）会被挤到最右侧截断。
 */
export function SettingRow({
  item,
  value,
  error,
  disabledReason,
  onChange,
  onEdit,
  onDelete,
}: {
  item: ConfigItem
  value: string
  error?: string
  /** 依赖不满足时的原因（如「失败阈值为 0，锁定已禁用」），给了就置灰 */
  disabledReason?: string | null
  onChange: (v: string) => void
  onEdit: (c: ConfigItem) => void
  onDelete: (c: ConfigItem) => void
}) {
  const { t } = useTranslation()
  const meta = metaOf(item.key)
  const dirty = value !== item.value
  const disabled = Boolean(disabledReason)
  // registry.ts 里的 label/hint 是**中文字面量常量**，而 key 就是中文原文 ——
  // 所以在渲染处 t() 就够了，注册表本身一个字都不用改
  const label = t(meta?.label ?? item.name)
  const hint = meta?.hint ?? item.remark
  const hintText = hint ? t(hint) : undefined

  return (
    <div
      data-testid={`setting-${item.key}`}
      data-dirty={String(dirty)}
      data-invalid={String(Boolean(error))}
      className={cn(
        'group/row flex flex-col gap-2 border-b border-border/60 px-4 py-3.5 last:border-b-0 @2xl/panel:flex-row @2xl/panel:items-center @2xl/panel:gap-6',
        dirty && 'bg-amber-500/[0.04]',
        error && 'bg-destructive/[0.04]'
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>{label}</span>
          {item.is_frontend && (
            <Badge variant="outline" className="gap-1 font-normal">
              <IconDeviceDesktop className="size-3" />
              {t('前端可读')}
            </Badge>
          )}
          {dirty && (
            <span className="text-[11px] text-amber-700 dark:text-amber-300" data-testid={`dirty-${item.key}`}>
              {t('已修改')}
            </span>
          )}
        </span>
        {hintText && <span className="text-xs leading-snug text-muted-foreground">{hintText}</span>}
        <code className="text-[11px] leading-snug text-muted-foreground/70">{item.key}</code>
        {disabledReason && (
          <span className="text-[11px] text-muted-foreground" data-testid={`disabled-${item.key}`}>
            {disabledReason}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-start gap-2">
        <div className="flex flex-col items-end gap-1">
          <ValueEditor
            item={item}
            value={value}
            dirty={dirty}
            invalid={Boolean(error)}
            disabled={disabled}
            onChange={onChange}
          />
          {error && (
            <span className="text-xs text-destructive" data-testid={`err-${item.key}`}>{error}</span>
          )}
        </div>
        {/* 键本身的增删改是**副入口** —— 平时没人动，收进 kebab 菜单 */}
        <DropdownMenu>
          <DropdownMenuTrigger
            /* 悬停/键盘聚焦才显形。用 opacity 而不是 display：
               display:none 会让它键盘不可达，也会让 E2E 点不到 */
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-8 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-popup-open:opacity-100"
                aria-label={t('更多 {{what}}', { what: label })}
              />
            }
            data-testid={`row-menu-${item.key}`}
          >
            <IconDotsVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <Can perm="sys:config:edit">
              <DropdownMenuItem onClick={() => onEdit(item)} data-testid={`edit-${item.key}`}>
                <IconPencil className="size-4" />
                {t('编辑键定义')}
              </DropdownMenuItem>
            </Can>
            <Can perm="sys:config:del">
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(item)} data-testid={`del-${item.key}`}>
                <IconTrash className="size-4" />
                {t('删除')}
              </DropdownMenuItem>
            </Can>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
