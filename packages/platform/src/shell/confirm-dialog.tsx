import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@admin/ui/components/dialog'

/**
 * 二次确认弹窗（带 pending 态）。
 *
 * `@admin/ui` 里那个 ConfirmDialog 的 onConfirm 是同步的，
 * 而删除要等接口返回 —— 这里包一层支持 async + 加载态。
 *
 * ⚠️ 必须渲染成触发器的**兄弟节点**，不能放进 DropdownMenuContent：
 * 菜单项点击后会卸载菜单内容，弹窗会跟着一起被拆掉。
 * 惯用法是菜单项只写入 "pendingXxx" 状态，弹窗从该状态读。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  destructive = false,
  pending = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  pending?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>{cancelText ?? t('取消')}</DialogClose>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            data-testid="confirm-ok"
            onClick={() => void onConfirm()}
          >
            {pending && <IconLoader2 className="size-4 animate-spin" />}
            {confirmText ?? t('确定')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
