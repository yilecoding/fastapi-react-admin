import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconUpload, IconX } from '@tabler/icons-react'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { Skeleton } from '@admin/ui/components/skeleton'
import { useFilePicker } from '@admin/ui/components/uploader/dropzone'

import { usePerm } from '../../auth/use-perm'
import { useUploadStore } from '../../shell/upload-store'
import { fileKeys, formatBytes, targetFilesQuery, type FileItem } from '../file/api'
import { FileTypeIcon } from '../file/file-icon'
import { useFileUploader } from '../file/uploader'
import { NOTICE_ATTACHMENT_MAX, NOTICE_ATTACHMENT_TARGET } from './api'

/**
 * 公告表单里的「附件」（#186）。
 *
 * 原来附件只能在「查看」抽屉里挂：要先保存、再打开抽屉传 —— 而状态默认是「显示」，
 * 一保存就发了广播，**读者收到通知时附件还没挂上**。现在附件跟着表单一起提交
 * （`attachment_ids`），后端在同一个事务里先挂附件、再发广播。
 *
 * 状态是 `draft ?? baseline` 两层（[pages 分册](../AGENTS.md)「主从页 · 其他约定」同一个写法）：
 *
 * - `baseline` = 服务端现在挂着的（编辑时现取；新建是空的）
 * - `draft` = 用户动过之后的那一份；**没动过是 `null`**
 *
 * 🔴 `draft === null` 时提交**不带** `attachment_ids`（= 附件不动）。编辑时附件列表还没取回来 /
 * 取失败了，界面上是空的 —— 这时候要是照着界面发一个 `[]`，就是把人家的附件全摘了。
 */
export function useNoticeAttachments({ open, noticeId }: { open: boolean; noticeId: string | null }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const baselineQuery = useQuery({
    ...targetFilesQuery(NOTICE_ATTACHMENT_TARGET, noticeId ?? ''),
    enabled: open && noticeId !== null,
  })
  const baseline: FileItem[] | undefined = noticeId === null ? [] : baselineQuery.data
  const [draft, setDraft] = React.useState<FileItem[] | null>(null)

  /**
   * 第几次打开。上传是全局队列（关了表单照样传完），传完的回调在队列里 ——
   * 关掉表单再打开另一条公告时，上一轮迟到的文件不能落进这一轮的列表。
   *
   * ⚠️ 只在「真的换了一次打开」时重置，不是每次 effect 跑都重置：
   * `<Activity>` 把隐藏的 tab 切回来时会把 effect 整个重建再跑一遍（e2e 分册那条），
   * 按 effect 次数重置的话，切一下标签页填好的附件就没了。比较的是 ref 里存的「上一次打开的是谁」
   */
  const [session, setSession] = React.useState(0)
  const openedFor = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    const key = open ? (noticeId ?? '<new>') : undefined
    if (key === openedFor.current) return
    openedFor.current = key
    if (key !== undefined) {
      setDraft(null)
      setSession((s) => s + 1)
    }
  }, [open, noticeId])

  /** 改 draft 之前先把 baseline 抄过来 —— 回调里读的是**当时**的缓存，不是渲染那一刻闭包里的 */
  const current = React.useCallback(
    (d: FileItem[] | null): FileItem[] =>
      d ?? (noticeId === null ? [] : (qc.getQueryData<FileItem[]>(fileKeys.target(NOTICE_ATTACHMENT_TARGET, noticeId)) ?? [])),
    [noticeId, qc]
  )

  // 回调存在全局队列里、可能在很久以后才跑 —— 拿「那时」的 session 比，得读 ref
  const sessionRef = React.useRef(session)
  React.useEffect(() => {
    sessionRef.current = session
  }, [session])

  // 来源名单独起一个，不跟别处的附件面板（`附件`）共用：
  // 「上传中」的计数是按来源数的，共用的话那边传东西会把这里的提交按钮也挡住
  const uploader = useFileUploader({
    source: t('公告附件'),
    onDone: (item) => {
      const file = item.result
      // `session` 是点「添加附件」那一刻的，`sessionRef` 是现在的 —— 对不上就是上一轮打开时传的
      if (!file || session !== sessionRef.current) return
      setDraft((d) => {
        const base = current(d)
        // 同一个文件选两次（或秒传命中已挂的）只留一行
        return base.some((f) => f.id === file.id) ? base : [...base, file]
      })
    },
  })

  const remove = React.useCallback(
    (id: string) => setDraft((d) => current(d).filter((f) => f.id !== id)),
    [current]
  )

  const files = draft ?? baseline ?? []
  return {
    files,
    /** 编辑时附件列表取回来了（新建恒为 true）。没取回来之前不让增删 —— 增删的起点必须是真实的那一份 */
    ready: baseline !== undefined,
    loading: noticeId !== null && baselineQuery.isPending,
    error: baselineQuery.error,
    retry: () => void baselineQuery.refetch(),
    /** 提交用：没动过就是 `undefined`（附件不动） */
    ids: draft === null ? undefined : draft.map((f) => f.id),
    add: uploader.add,
    remove,
    /** 这个表单还有几个文件在传 / 在排队。大于 0 时不能提交 —— 提交出去的列表里会少了它们 */
    pending: uploader.pending,
    tooMany: files.length > NOTICE_ATTACHMENT_MAX,
  }
}

export type NoticeAttachments = ReturnType<typeof useNoticeAttachments>

export function NoticeAttachmentField({ state }: { state: NoticeAttachments }) {
  const { t } = useTranslation()
  const { can } = usePerm()
  const canUpload = can('sys:file:upload')
  const picker = useFilePicker({ onFiles: state.add })
  const full = state.files.length >= NOTICE_ATTACHMENT_MAX

  return (
    <div className="flex flex-col gap-2" data-testid="n-attachments">
      {state.loading ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : state.error ? (
        // 硬纪律 9：取不回来就说取不回来 —— 显示成「没有附件」的话，下一步就是有人以为真没有
        <Alert
          tone="danger"
          className="py-2 text-xs"
          action={
            <Button size="sm" variant="outline" type="button" onClick={state.retry} data-testid="n-attach-retry">
              {t('重试')}
            </Button>
          }
        >
          {t('附件列表加载失败，现在保存不会改动已有附件')}
        </Alert>
      ) : state.files.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="n-attach-list">
          {state.files.map((f) => (
            <li
              key={f.id}
              className="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5"
              data-testid={`n-attach-item-${f.id}`}
            >
              <FileTypeIcon file={f} className="size-4" />
              <span className="min-w-0 flex-1 truncate text-sm" title={f.original_name}>
                {f.original_name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(f.size)}</span>
              {/* 只是从这条公告上摘下来（提交时生效），文件本身还在「文件管理」里 */}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('移除 {{name}}', { name: f.original_name })}
                data-testid={`n-attach-remove-${f.id}`}
                onClick={() => state.remove(f.id)}
              >
                <IconX className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canUpload ? (
          <>
            <input {...picker.inputProps} data-testid="n-attach-input" />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!state.ready || full}
              onClick={picker.open}
              data-testid="n-attach-upload"
            >
              <IconUpload className="size-4" />
              {t('添加附件')}
            </Button>
          </>
        ) : (
          // 没上传权限不能悄悄不给按钮 —— 那和「这个表单不支持附件」长得一样
          <span className="text-xs text-muted-foreground" data-testid="n-attach-no-perm">
            {t('没有上传文件的权限（sys:file:upload），挂不了附件')}
          </span>
        )}
        {state.pending > 0 && (
          /* 进度在右下角的浮窗里；这里只留一句，点一下把折叠的浮窗展开 */
          <button
            type="button"
            className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
            onClick={() => useUploadStore.getState().setCollapsed(false)}
            data-testid="n-attach-uploading"
          >
            {t('{{n}} 个文件上传中，进度在右下角', { n: state.pending })}
          </button>
        )}
      </div>
    </div>
  )
}
