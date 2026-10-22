import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as React from 'react'

import { toast } from '@admin/ui/components/toast'
import { UploadTray as UploadTrayView } from '@admin/ui/components/uploader/upload-tray'

import { fileKeys } from '../pages/file/api'
import { trayEta, traySummary } from '../upload'
import { ConfirmDialog } from './confirm-dialog'
import { useUploadStore } from './upload-store'

/**
 * 右下角上传浮窗（壳层家具，挂在页签之外 —— 切 tab、关 tab 都不影响它）。
 *
 * - 有活跃上传时点 × 先确认「取消全部并关闭」；没有就直接关
 * - 折叠时某个文件传完弹一条 toast —— 折叠着的浮窗不会自己说话，大文件传完了用户可能不知道
 * - 有活跃上传时离开页面（刷新 / 关标签页）弹浏览器的「确定离开」：没有断点续传，刷新就丢
 */
export function UploadTray() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const items = useUploadStore((s) => s.items)
  const open = useUploadStore((s) => s.open)
  const collapsed = useUploadStore((s) => s.collapsed)
  const { cancel, retry, remove, cancelAll, setCollapsed, close, bind } = useUploadStore.getState()
  const [confirmClose, setConfirmClose] = React.useState(false)

  React.useEffect(() => {
    bind(() => void qc.invalidateQueries({ queryKey: fileKeys.all }))
  }, [bind, qc])

  const summary = traySummary(items)

  // 离开页面前拦一下：刷新 / 关标签页会把进行中的上传全丢掉
  React.useEffect(() => {
    if (!summary.busy) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [summary.busy])

  // 折叠态下的完成提示：对比上一次的 done 集合，新 done 的逐个 toast
  const seenDone = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    for (const it of items) {
      if (it.status !== 'done' || seenDone.current.has(it.id)) continue
      seenDone.current.add(it.id)
      if (collapsed) toast.success(t('{{name}} 上传完成', { name: it.name }), { timeout: 4000 })
    }
  }, [items, collapsed, t])

  if (!open || items.length === 0) return null

  return (
    <>
      <UploadTrayView
        items={items.map((it) => ({ ...it, source: it.opts.source ?? null }))}
        collapsed={collapsed}
        etaSeconds={trayEta(items)}
        onToggle={() => setCollapsed(!collapsed)}
        onClose={() => (summary.busy ? setConfirmClose(true) : close())}
        onCancelAll={cancelAll}
        onCancel={cancel}
        onRetry={retry}
        onRemove={remove}
      />
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t('取消全部上传？')}
        description={t('还有 {{n}} 个文件没传完，关闭浮窗会把它们全部取消。', { n: summary.active + summary.queued })}
        confirmText={t('取消上传并关闭')}
        destructive
        onConfirm={() => {
          close()
          setConfirmClose(false)
        }}
      />
    </>
  )
}
