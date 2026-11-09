import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconLoader2 } from '@tabler/icons-react'

import { Alert } from '@admin/ui/components/alert'
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
 *
 * 🔴 失败原因走 `error`，**不要拿它顶替 `description`**。原来 8 个页面都是
 * `description={err ? <红字>{err}</红字> : 问题}` —— 报错一出来，「确定删除『后端组』吗」
 * 那句话就没了，弹窗里只剩一行红字和一个照样能点的「删除」，看不出是在删谁、刚才发生了什么。
 * 现在问题留在原处，原因另起一条提示条（`role="alert"`，读屏会念出来）。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  error,
  confirmText,
  cancelText,
  destructive = false,
  pending = false,
  blocked = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: React.ReactNode
  /** 上一次确认失败的原因（接口报错原文）。有值时显示在问题下面，问题本身不动 */
  error?: string | null
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  pending?: boolean
  /** 前端已经知道这一步一定会被拒（比如部门下还挂着子部门）：照样说清楚，但不给一个注定失败的按钮 */
  blocked?: boolean
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
        {error && (
          <Alert tone="danger" data-testid="confirm-error">
            {error}
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>{cancelText ?? t('取消')}</DialogClose>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending || blocked}
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
