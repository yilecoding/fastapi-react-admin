import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconFileSpreadsheet,
  IconLoader2,
  IconUpload,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'

import {
  downloadImportTemplate,
  useImportCommit,
  useImportPreview,
  type ImportPreview,
  type ImportPreviewRow,
} from './api'

/**
 * 批量导入用户 —— 两阶段：**预览校验 → 确认提交**。
 *
 * 为什么不是选完文件直接导：87 行里 3 行打字错误，不该让 84 行正确的一起重来；
 * 而「跳过失败继续」用在**创建**上又太糙（删除是幂等的，创建会产生新数据）。
 * 所以先看一眼、再决定导哪些。
 *
 * 🔴 **失败必须是可见状态，不是缺失状态**（硬纪律 9）。这一屏有三处会失败
 * （下载模板 / 预览 / 提交），每一处都显示错误 + 重试入口 ——
 * 把错误吞掉让按钮消失，等于告诉用户「这个功能不存在」。
 *
 * ⚠️ **`import_token` 是一次性的**：服务端在建号**之前**就把它删了（不删的话
 * 重放一次就是重复建号）。所以提交失败之后**不能拿同一个 token 重试**，
 * 这一屏在那种情况下会把用户送回「重新选文件」，而不是留一个点了没反应的按钮。
 */
export function UserImportSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useTranslation()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const preview = useImportPreview()
  const commit = useImportCommit()

  const [fileName, setFileName] = React.useState<string | null>(null)
  /** 用户主动排除的行（**Excel 行号**）。只对「可导入」的行有意义 */
  const [excluded, setExcluded] = React.useState<Set<number>>(new Set())
  const [templateError, setTemplateError] = React.useState<string | null>(null)
  const [templateBusy, setTemplateBusy] = React.useState(false)

  const data = preview.data ?? null
  const result = commit.data ?? null

  const reset = React.useCallback(() => {
    preview.reset()
    commit.reset()
    setFileName(null)
    setExcluded(new Set())
    setTemplateError(null)
    // ⚠️ 不清 input 的 value 的话，用户改完 Excel 再选**同一个文件**不会触发
    // change 事件 —— 表现成「点了没反应」，而文件确实变了
    if (inputRef.current) inputRef.current.value = ''
  }, [commit, preview])

  // 关闭时清干净。留着上一次的预览结果，下次打开会看到一份**过期的** token
  // 和一份对不上当前库状态的校验结论
  React.useEffect(() => {
    if (!open) reset()
    // reset 的依赖是两个 mutation 对象，它们每次 render 都是新的引用；
    // 这里只想在 open 变化时跑，所以刻意只依赖 open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handlePick = React.useCallback(
    (file: File | undefined) => {
      if (!file) return
      setFileName(file.name)
      setExcluded(new Set())
      commit.reset()
      preview.mutate(file)
    },
    [commit, preview]
  )

  const handleTemplate = React.useCallback(async () => {
    setTemplateError(null)
    setTemplateBusy(true)
    try {
      await downloadImportTemplate(t('用户导入模板.xlsx'))
    } catch (e) {
      setTemplateError(e instanceof Error ? e.message : t('下载失败'))
    } finally {
      setTemplateBusy(false)
    }
  }, [t])

  const importable = React.useMemo(
    () => (data?.rows ?? []).filter((r) => r.ok && !excluded.has(r.row_no)),
    [data, excluded]
  )

  const toggleRow = React.useCallback((rowNo: number, on: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (on) next.delete(rowNo)
      else next.add(rowNo)
      return next
    })
  }, [])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 🔴 覆盖宽度**必须带同样的变体前缀**。基础类是
          `data-[side=right]:sm:max-w-sm`，而 `cn()` 是 tailwind-merge ——
          它只在同一变体作用域内消解冲突，写成裸 `sm:max-w-3xl` 两条会一起留下、
          基础类赢。表现是**类在、宽度没变**，而「校验」那一列被挤出视口，
          错误信息在 DOM 里但用户看不见（见 packages/ui/AGENTS.md 那一节）。
          实测踩过一次，是截图看出来的，文本断言完全没发现 */}
      <SheetContent
        side="right"
        className="data-[side=right]:sm:max-w-3xl"
        data-testid="user-import-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t('批量导入用户')}</SheetTitle>
          <SheetDescription>
            {t('上传 xlsx 表格，先预览校验结果，确认后再创建。部门和角色填编码，不是名称。')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
          {/* ── 第一步：模板 + 选文件。**任何阶段都留着**，用户随时可以换一份文件 ── */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={templateBusy}
              data-testid="download-template"
              onClick={() => void handleTemplate()}
            >
              {templateBusy ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconDownload className="size-4" />
              )}
              {t('下载模板')}
            </Button>

            <input
              ref={inputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              data-testid="import-file-input"
              onChange={(e) => handlePick(e.target.files?.[0])}
            />
            <Button
              size="sm"
              variant={data ? 'outline' : 'default'}
              disabled={preview.isPending}
              data-testid="pick-import-file"
              onClick={() => inputRef.current?.click()}
            >
              {preview.isPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconUpload className="size-4" />
              )}
              {data ? t('重新选择') : t('选择文件')}
            </Button>

            {fileName ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                <IconFileSpreadsheet className="size-3.5 shrink-0" />
                <span className="truncate">{fileName}</span>
              </span>
            ) : null}
          </div>

          {templateError ? <ErrorNote>{templateError}</ErrorNote> : null}

          {/* 🔴 预览失败要显示出来 + 留重试入口。吞掉的话用户看到的是
              「选了文件、什么都没发生」，而那和「这个功能坏了」无法区分 */}
          {preview.error ? (
            <ErrorNote testId="import-preview-error">
              {preview.error instanceof Error ? preview.error.message : t('预览失败')}
            </ErrorNote>
          ) : null}

          {/* ── 第三步的结果优先展示：提交完之后不该再显示那份已经作废的预览 ── */}
          {result ? (
            <ImportResult result={result} onAgain={reset} />
          ) : data ? (
            <PreviewPanel
              data={data}
              excluded={excluded}
              onToggleRow={toggleRow}
              commitError={
                commit.error instanceof Error ? commit.error.message : commit.error ? t('导入失败') : null
              }
            />
          ) : preview.isPending ? (
            <p className="py-8 text-center text-muted-foreground text-sm">{t('正在解析表格…')}</p>
          ) : (
            <EmptyHint />
          )}
        </div>

        <SheetFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)} data-testid="import-done">
              {t('完成')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('取消')}
              </Button>
              <Button
                disabled={!data || importable.length === 0 || commit.isPending}
                data-testid="confirm-import"
                onClick={() => {
                  if (!data) return
                  commit.mutate({
                    import_token: data.import_token,
                    exclude_rows: [...excluded],
                  })
                }}
              >
                {commit.isPending ? <IconLoader2 className="size-4 animate-spin" /> : null}
                {t('导入 {{n}} 个用户', { n: importable.length })}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function EmptyHint() {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-dashed px-4 py-8 text-center">
      <IconFileSpreadsheet className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-2 text-muted-foreground text-sm">
        {t('先下载模板，填好后上传。只支持 .xlsx。')}
      </p>
      {/* 说清楚密码从哪来 —— 模板里没有密码列，不写的话管理员会以为漏了一列 */}
      <p className="mt-1 text-muted-foreground text-xs">
        {t('导入的账号统一使用系统默认密码，请导入后通知本人尽快修改。')}
      </p>
    </div>
  )
}

function ErrorNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-sm"
    >
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

function PreviewPanel({
  data,
  excluded,
  onToggleRow,
  commitError,
}: {
  data: ImportPreview
  excluded: Set<number>
  onToggleRow: (rowNo: number, on: boolean) => void
  commitError: string | null
}) {
  const { t } = useTranslation()
  const invalid = data.total - data.valid

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{t('共 {{n}} 行', { n: data.total })}</Badge>
        <Badge variant="secondary">{t('可导入 {{n}} 行', { n: data.valid })}</Badge>
        {invalid > 0 ? <Badge variant="destructive">{t('有问题 {{n}} 行', { n: invalid })}</Badge> : null}
        {data.empty_rows > 0 ? (
          <span className="text-muted-foreground text-xs">
            {t('已跳过 {{n}} 个空行', { n: data.empty_rows })}
          </span>
        ) : null}
      </div>

      {/* 🔴 未识别的表头必须显示。`phone` 拼成 `phone_number` 时整份文件照样
          解析成功，只是那一列的数据**全丢了** —— 不说的话没有任何现象 */}
      {data.ignored_headers.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <span className="min-w-0">
            {t('这些列没被识别，其中的数据不会导入：{{cols}}', {
              cols: data.ignored_headers.join('、'),
            })}
          </span>
        </div>
      ) : null}

      {/* 🔴 提交失败时 token 已经作废了（服务端建号前就删），不能原地重试 ——
          所以这里明确让用户重新选文件，而不是留一个点了没反应的「导入」按钮 */}
      {commitError ? (
        <ErrorNote testId="import-commit-error">
          {commitError}
          <span className="mt-1 block text-xs opacity-80">
            {t('导入令牌只能用一次，请重新选择文件后再试。')}
          </span>
        </ErrorNote>
      ) : null}

      <div className="min-h-0 overflow-auto rounded-md border">
        <table className="w-full text-sm" data-testid="import-preview-table">
          <thead className="sticky top-0 bg-muted/50 text-xs">
            <tr>
              <th className="w-10 px-2 py-2" />
              {/* 行号是 **Excel 里的真实行号**，用户要拿着它回表格里定位 */}
              <th className="px-2 py-2 text-start font-medium">{t('行')}</th>
              <th className="px-2 py-2 text-start font-medium">{t('用户名')}</th>
              <th className="px-2 py-2 text-start font-medium">{t('部门')}</th>
              <th className="px-2 py-2 text-start font-medium">{t('角色')}</th>
              <th className="px-2 py-2 text-start font-medium">{t('校验')}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <PreviewRow
                key={row.row_no}
                row={row}
                excluded={excluded.has(row.row_no)}
                onToggle={onToggleRow}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PreviewRow({
  row,
  excluded,
  onToggle,
}: {
  row: ImportPreviewRow
  excluded: boolean
  onToggle: (rowNo: number, on: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <tr className="border-t" data-testid="import-preview-row" data-row-no={row.row_no}>
      <td className="px-2 py-1.5">
        {/* 有问题的行本来就不会被创建，勾选框对它没有意义 —— 禁用而不是隐藏，
            隐藏会让那一列忽宽忽窄 */}
        <Checkbox
          checked={row.ok && !excluded}
          disabled={!row.ok}
          aria-label={t('导入第 {{n}} 行', { n: row.row_no })}
          onCheckedChange={(v) => onToggle(row.row_no, v === true)}
        />
      </td>
      <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{row.row_no}</td>
      <td className="px-2 py-1.5 font-medium">{row.username ?? '—'}</td>
      <td className="px-2 py-1.5">{row.dept_code ?? '—'}</td>
      <td className="px-2 py-1.5">{row.role_codes.length > 0 ? row.role_codes.join(', ') : '—'}</td>
      <td className="px-2 py-1.5">
        {row.ok ? (
          <span className="inline-flex items-center gap-1 text-emerald-600 text-xs">
            <IconCheck className="size-3.5" />
            {excluded ? t('已排除') : t('可导入')}
          </span>
        ) : (
          // 具体错在哪个字段、为什么 —— 只说「这一行有问题」等于让用户自己猜
          <span className="text-destructive text-xs">{row.errors.join('；')}</span>
        )}
      </td>
    </tr>
  )
}

function ImportResult({
  result,
  onAgain,
}: {
  result: { created: string[]; failed: Array<{ row_no: number; msg: string }>; used_default_password: boolean }
  onAgain: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3" data-testid="import-result">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{t('成功 {{n}} 个', { n: result.created.length })}</Badge>
        {result.failed.length > 0 ? (
          <Badge variant="destructive">{t('失败 {{n}} 个', { n: result.failed.length })}</Badge>
        ) : null}
      </div>

      {/* ⚠️ 这句必须说，而且要显眼：仓库里**没有**强制首次改密的机制，
          不提醒的话这批账号会一直挂着同一个默认密码 */}
      {result.used_default_password && result.created.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          {t('这批账号使用系统默认密码，请通知本人尽快修改。')}
        </div>
      ) : null}

      {result.created.length > 0 ? (
        <div className="rounded-md border px-3 py-2">
          <p className="mb-1 font-medium text-xs">{t('已创建')}</p>
          <p className="break-words text-muted-foreground text-sm">{result.created.join('、')}</p>
        </div>
      ) : null}

      {/* 失败的行要带**行号**：提交阶段的失败几乎只有「两步之间被人抢注了同一个
          用户名」这一种，用户需要回 Excel 里定位那一行 */}
      {result.failed.length > 0 ? (
        <div className="rounded-md border border-destructive/40 px-3 py-2">
          <p className="mb-1 font-medium text-destructive text-xs">{t('未创建')}</p>
          <ul className="space-y-0.5 text-sm">
            {result.failed.map((f) => (
              <li key={f.row_no} className="text-muted-foreground">
                {t('第 {{n}} 行', { n: f.row_no })}：{f.msg}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <Button variant="outline" size="sm" onClick={onAgain} data-testid="import-again">
          {t('再导一批')}
        </Button>
      </div>
    </div>
  )
}
