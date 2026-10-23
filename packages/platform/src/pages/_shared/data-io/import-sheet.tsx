import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { QueryKey } from '@tanstack/react-query'
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

import { SegmentedControl } from '../settings-rows'
import {
  downloadImportReport,
  downloadImportTemplate,
  useImportCommit,
  useImportPreview,
  type ImportCommitResult,
  type ImportMode,
  type ImportPreview,
  type ImportPreviewRow,
} from './api'

/**
 * 批量导入（#11 · v0.4）—— 两阶段：**预览校验 → 确认提交**。所有能导入的资源共用这一份，
 * 资源之间的差别（列、模式、校验规则）全在后端的导入定义里。
 *
 * 为什么不是选完文件直接导：87 行里 3 行打字错误，不该让 84 行正确的一起重来；
 * 先看一眼、再决定导哪些。有问题的行能下载成一份「原样 + 原因」的表，改完直接再导。
 *
 * 🔴 **失败必须是可见状态，不是缺失状态**（硬纪律 9）。这一屏有四处会失败
 * （下载模板 / 预览 / 提交 / 下载错误报告），每一处都显示错误 + 重试入口。
 *
 * ⚠️ **令牌是一次性的**：服务端在写库**之前**就把它删了（不删的话双击 / 重试会写两遍）。
 * 所以提交失败之后**不能拿同一个令牌重试**，这一屏会把用户送回「重新选文件」。
 *
 * ⚠️ **换了导入方式要重新预览**：令牌绑着预览时的模式（同一行在「只新增」下是错、
 * 在「新增并更新」下是更新），所以模式一变就拿同一个文件重跑一遍预览，而不是沿用旧结论。
 */
export function ImportSheet({
  open,
  onOpenChange,
  base,
  title,
  description,
  hint,
  modes = ['create'],
  invalidate,
  previewKeys,
  testId = 'import-sheet',
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 导入接口前缀，如 `/api/v1/sys/depts/import`（下面挂 template / preview / commit） */
  base: string
  title: string
  description: React.ReactNode
  /** 空态里多说的一句（用户导入：「统一使用系统默认密码」） */
  hint?: React.ReactNode
  /** 这个资源支持的模式，第一个是默认 */
  modes?: ImportMode[]
  /** 提交成功后要失效的查询（列表页的 query key 前缀） */
  invalidate: QueryKey
  /** 预览表里摆哪几列（列 key）。不给就摆全部 —— 列多的资源会把「校验」那一列挤出去 */
  previewKeys?: string[]
  testId?: string
}) {
  const { t } = useTranslation()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const preview = useImportPreview(base)
  const commit = useImportCommit(base, invalidate)

  const [mode, setMode] = React.useState<ImportMode>(modes[0])
  /** 选中的文件留着：换导入方式时要拿它重跑预览 */
  const [file, setFile] = React.useState<File | null>(null)
  /** 用户主动排除的行（**Excel 行号**）。只对「可导入」的行有意义 */
  const [excluded, setExcluded] = React.useState<Set<number>>(new Set())
  const [atomic, setAtomic] = React.useState(false)
  const [downloadError, setDownloadError] = React.useState<string | null>(null)
  const [downloading, setDownloading] = React.useState<'template' | 'report' | null>(null)

  const data = preview.data ?? null
  const result = commit.data ?? null

  const reset = React.useCallback(() => {
    preview.reset()
    commit.reset()
    setFile(null)
    setExcluded(new Set())
    setDownloadError(null)
    // ⚠️ 不清 input 的 value 的话，用户改完 Excel 再选**同一个文件**不会触发
    // change 事件 —— 表现成「点了没反应」，而文件确实变了
    if (inputRef.current) inputRef.current.value = ''
  }, [commit, preview])

  // 关闭时清干净。留着上一次的预览结果，下次打开会看到一份**过期的**令牌
  // 和一份对不上当前库状态的校验结论
  React.useEffect(() => {
    if (!open) reset()
    // reset 的依赖是两个 mutation 对象，它们每次 render 都是新的引用；只想在 open 变化时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const runPreview = React.useCallback(
    (next: File, nextMode: ImportMode) => {
      setExcluded(new Set())
      commit.reset()
      preview.mutate({ file: next, mode: nextMode })
    },
    [commit, preview]
  )

  const handlePick = React.useCallback(
    (picked: File | undefined) => {
      if (!picked) return
      setFile(picked)
      runPreview(picked, mode)
    },
    [mode, runPreview]
  )

  const handleMode = React.useCallback(
    (next: ImportMode) => {
      setMode(next)
      if (file && !result) runPreview(file, next)
    },
    [file, result, runPreview]
  )

  const download = React.useCallback(
    async (kind: 'template' | 'report') => {
      setDownloadError(null)
      setDownloading(kind)
      try {
        if (kind === 'template') await downloadImportTemplate(base, t('{{title}}模板.xlsx', { title }))
        else if (data) await downloadImportReport(data.import_token, t('导入错误报告.xlsx'))
      } catch (e) {
        setDownloadError(e instanceof Error ? e.message : t('下载失败'))
      } finally {
        setDownloading(null)
      }
    },
    [base, data, t, title]
  )

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

  const reportButton = (
    <Button
      variant="outline"
      size="sm"
      aria-busy={downloading === 'report'}
      data-testid="download-import-report"
      onClick={() => void download('report')}
    >
      {downloading === 'report' ? <IconLoader2 className="size-4 animate-spin" /> : <IconDownload className="size-4" />}
      {t('下载错误报告')}
    </Button>
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 🔴 覆盖宽度**必须带同样的变体前缀**（`data-[side=right]:sm:`）。裸 `sm:max-w-3xl`
          两条会一起留下、基础类赢，「校验」那一列被挤出视口 —— 错误信息在 DOM 里但用户看不见
          （见 packages/ui/AGENTS.md「为什么有些覆盖有效、有些无声失效」） */}
      <SheetContent side="right" className="data-[side=right]:sm:max-w-3xl" data-testid={testId}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4">
          {/* ── 导入方式：只有支持多种模式的资源才摆出来 ── */}
          {modes.length > 1 && !result ? (
            <div className="flex flex-col gap-2" data-testid="import-mode">
              <SegmentedControl<ImportMode>
                value={mode}
                onChange={handleMode}
                options={modes.map((m) => ({ value: m, label: modeText(t)[m].label }))}
              />
              <p className="text-muted-foreground text-xs">{modeText(t)[mode].hint}</p>
            </div>
          ) : null}

          {/* ── 模板 + 选文件。**任何阶段都留着**，用户随时可以换一份文件 ── */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-busy={downloading === 'template'}
              data-testid="download-template"
              onClick={() => void download('template')}
            >
              {downloading === 'template' ? (
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
              {preview.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconUpload className="size-4" />}
              {data ? t('重新选择') : t('选择文件')}
            </Button>

            {file ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                <IconFileSpreadsheet className="size-3.5 shrink-0" />
                <span className="truncate">{file.name}</span>
              </span>
            ) : null}
          </div>

          {downloadError ? <ErrorNote>{downloadError}</ErrorNote> : null}

          {/* 🔴 预览失败要显示出来 + 留重试入口。吞掉的话用户看到的是
              「选了文件、什么都没发生」，而那和「这个功能坏了」无法区分 */}
          {preview.error ? (
            <ErrorNote testId="import-preview-error">
              {preview.error instanceof Error ? preview.error.message : t('预览失败')}
            </ErrorNote>
          ) : null}

          {/* ── 提交的结果优先展示：提交完之后不该再显示那份已经作废的预览 ── */}
          {result ? (
            <ImportResult result={result} report={result.has_report ? reportButton : null} onAgain={reset} />
          ) : data ? (
            <PreviewPanel
              data={data}
              excluded={excluded}
              onToggleRow={toggleRow}
              previewKeys={previewKeys}
              report={data.has_report ? reportButton : null}
              commitError={commit.error instanceof Error ? commit.error.message : commit.error ? t('导入失败') : null}
            />
          ) : preview.isPending ? (
            <p className="py-8 text-center text-muted-foreground text-sm">{t('正在解析表格…')}</p>
          ) : (
            <EmptyHint hint={hint} />
          )}
        </div>

        <SheetFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)} data-testid="import-done">
              {t('完成')}
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              {/* 两种失败哲学由用户选：能导的先导（默认），或者有一行失败就整批不导 */}
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={atomic}
                  onCheckedChange={(v) => setAtomic(v === true)}
                  data-testid="import-atomic"
                />
                <span className="flex flex-col gap-0.5">
                  <span>{t('全部成功才导入')}</span>
                  <span className="text-muted-foreground text-xs">
                    {t('勾选后，提交时有任何一行写不进去，这一批就一行都不写。')}
                  </span>
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t('取消')}
                </Button>
                <Button
                  disabled={!data || importable.length === 0 || commit.isPending}
                  data-testid="confirm-import"
                  onClick={() => {
                    if (!data) return
                    commit.mutate({ import_token: data.import_token, exclude_rows: [...excluded], atomic })
                  }}
                >
                  {commit.isPending ? <IconLoader2 className="size-4 animate-spin" /> : null}
                  {t('导入 {{n}} 行', { n: importable.length })}
                </Button>
              </div>
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** 三种模式的名字和说明。写成函数里的字面量 `t('…')`：放模块级常量再 `t(变量)`，`i18n:check` 看不见这些 key */
function modeText(t: (k: string) => string): Record<ImportMode, { label: string; hint: string }> {
  return {
    create: { label: t('只新增'), hint: t('文件里的编码在系统里已经存在的，那一行报错，不会覆盖。') },
    upsert: {
      label: t('新增并更新'),
      hint: t('编码已存在的更新，不存在的新增。更新时空白单元格表示保持原值。'),
    },
    update: {
      label: t('只更新'),
      hint: t('只更新已存在的，编码在系统里找不到的那一行报错。空白单元格表示保持原值。'),
    },
  }
}

/**
 * 按界面语言把一串名字连起来：中文「A、B、C」，英文「A, B, C」。
 * 不写死「、」—— 英文界面里那是一个看不懂的符号（目测截图看出来的）
 */
function useJoinList(): (items: string[]) => string {
  const { i18n } = useTranslation()
  return React.useMemo(() => {
    const format = new Intl.ListFormat(i18n.language, { type: 'conjunction', style: 'narrow' })
    return (items: string[]) => format.format(items)
  }, [i18n.language])
}

function EmptyHint({ hint }: { hint?: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-dashed px-4 py-8 text-center">
      <IconFileSpreadsheet className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-2 text-muted-foreground text-sm">
        {t('先下载模板，填好后上传。只支持 .xlsx；导出的表改完也能直接导回来。')}
      </p>
      {hint ? <p className="mt-1 text-muted-foreground text-xs">{hint}</p> : null}
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
  previewKeys,
  report,
  commitError,
}: {
  data: ImportPreview
  excluded: Set<number>
  onToggleRow: (rowNo: number, on: boolean) => void
  previewKeys?: string[]
  report: React.ReactNode
  commitError: string | null
}) {
  const { t } = useTranslation()
  const joinList = useJoinList()
  const invalid = data.total - data.valid
  const columns = previewKeys ? data.columns.filter((c) => previewKeys.includes(c.key)) : data.columns

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{t('共 {{n}} 行', { n: data.total })}</Badge>
        <Badge variant="secondary">{t('可导入 {{n}} 行', { n: data.valid })}</Badge>
        {data.to_update > 0 ? (
          <Badge variant="secondary">{t('其中更新 {{n}} 行', { n: data.to_update })}</Badge>
        ) : null}
        {invalid > 0 ? <Badge variant="destructive">{t('有问题 {{n}} 行', { n: invalid })}</Badge> : null}
        {data.empty_rows > 0 ? (
          <span className="text-muted-foreground text-xs">{t('已跳过 {{n}} 个空行', { n: data.empty_rows })}</span>
        ) : null}
        {report ? <span className="ms-auto">{report}</span> : null}
      </div>

      {/* 🔴 未识别的表头必须显示。列名拼错时整份文件照样解析成功，
          只是那一列的数据**全丢了** —— 不说的话没有任何现象 */}
      {data.ignored_headers.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <span className="min-w-0">
            {t('这些列没被识别，其中的数据不会导入：{{cols}}', { cols: joinList(data.ignored_headers) })}
          </span>
        </div>
      ) : null}

      {/* 🔴 提交失败时令牌已经作废了（服务端写库前就删），不能原地重试 ——
          所以这里明确让用户重新选文件，而不是留一个点了没反应的「导入」按钮 */}
      {commitError ? (
        <ErrorNote testId="import-commit-error">
          {commitError}
          <span className="mt-1 block text-xs opacity-80">{t('导入令牌只能用一次，请重新选择文件后再试。')}</span>
        </ErrorNote>
      ) : null}

      <div className="min-h-0 overflow-auto rounded-md border">
        <table className="w-full text-sm" data-testid="import-preview-table">
          <thead className="sticky top-0 bg-muted/50 text-xs">
            <tr>
              <th className="w-10 px-2 py-2" />
              {/* 行号是 **Excel 里的真实行号**，用户要拿着它回表格里定位 */}
              <th className="px-2 py-2 text-start font-medium">{t('行')}</th>
              {/* 🔴 「校验」紧跟行号，不放最后：数据列一多（或手机宽度下），最后一列在视口外 ——
                  错误信息在 DOM 里、测试全绿，人却得横着拖才看得到（390 宽截图看出来的） */}
              <th className="px-2 py-2 text-start font-medium">{t('校验')}</th>
              {columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-2 py-2 text-start font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <PreviewRow
                key={row.row_no}
                row={row}
                columns={columns.map((c) => c.key)}
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
  columns,
  excluded,
  onToggle,
}: {
  row: ImportPreviewRow
  columns: string[]
  excluded: boolean
  onToggle: (rowNo: number, on: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <tr className="border-t align-top" data-testid="import-preview-row" data-row-no={row.row_no}>
      <td className="px-2 py-1.5">
        {/* 有问题的行本来就不会写，勾选框对它没有意义 —— 禁用而不是隐藏，隐藏会让那一列忽宽忽窄 */}
        <Checkbox
          checked={row.ok && !excluded}
          disabled={!row.ok}
          aria-label={t('导入第 {{n}} 行', { n: row.row_no })}
          onCheckedChange={(v) => onToggle(row.row_no, v === true)}
        />
      </td>
      <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{row.row_no}</td>
      <td className="min-w-40 max-w-72 px-2 py-1.5">
        {row.ok ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-emerald-600 text-xs">
            <IconCheck className="size-3.5" />
            {excluded ? t('已排除') : row.action === 'update' ? t('将更新') : t('将新增')}
          </span>
        ) : (
          // 具体错在哪一列、为什么 —— 只说「这一行有问题」等于让用户自己猜。
          // 一条一行，不拼成一句：拼接用的标点（「；」）在英文界面里就是一个怪符号
          <ul className="flex flex-col gap-0.5 text-destructive text-xs">
            {row.errors.map((msg, i) => (
              <li key={`${i}:${msg}`}>{msg}</li>
            ))}
          </ul>
        )}
      </td>
      {columns.map((key) => (
        <td key={key} className="max-w-48 truncate px-2 py-1.5">
          {row.values[key] ?? '—'}
        </td>
      ))}
    </tr>
  )
}

function ImportResult({
  result,
  report,
  onAgain,
}: {
  result: ImportCommitResult
  report: React.ReactNode
  onAgain: () => void
}) {
  const { t } = useTranslation()
  const joinList = useJoinList()
  const written = [...result.created, ...result.updated]
  return (
    <div className="flex flex-col gap-3" data-testid="import-result">
      {/* 「全部成功才导入」且有行失败：**一行都没写**，这件事要第一句就说 */}
      {!result.committed ? (
        <ErrorNote testId="import-not-committed">
          {t('有 {{n}} 行写不进去，按「全部成功才导入」的设置，这一批一行都没有写入。', {
            n: result.failed.length,
          })}
        </ErrorNote>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{t('新增 {{n}} 条', { n: result.created.length })}</Badge>
          {result.updated.length > 0 ? (
            <Badge variant="secondary">{t('更新 {{n}} 条', { n: result.updated.length })}</Badge>
          ) : null}
          {result.failed.length > 0 ? (
            <Badge variant="destructive">{t('失败 {{n}} 条', { n: result.failed.length })}</Badge>
          ) : null}
        </div>
      )}

      {/* 后端要提醒的事（已翻译），比如「这批账号用的是系统默认密码」—— 没有强制首次改密的机制，
          这是唯一的告知渠道，所以要显眼 */}
      {result.notes.map((note) => (
        <div key={note} className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          {note}
        </div>
      ))}

      {result.committed && written.length > 0 ? (
        <div className="rounded-md border px-3 py-2">
          <p className="mb-1 font-medium text-xs">{t('已写入')}</p>
          <p className="break-words text-muted-foreground text-sm">
            {/* 一次能导上千行，全摊开就是一面墙：列前 50 个，其余说个数 */}
            {joinList(written.slice(0, 50))}
            {written.length > 50 ? t('…等 {{n}} 条', { n: written.length }) : null}
          </p>
        </div>
      ) : null}

      {/* 失败的行带**行号**：提交阶段的失败几乎都是「预览之后库里变了」（别人抢先建了同一个编码），
          用户要回 Excel 里定位那一行 */}
      {result.failed.length > 0 ? (
        <div className="rounded-md border border-destructive/40 px-3 py-2">
          <p className="mb-1 font-medium text-destructive text-xs">{t('未写入')}</p>
          <ul className="space-y-0.5 text-sm">
            {result.failed.map((f) => (
              <li key={f.row_no} className="text-muted-foreground">
                {t('第 {{n}} 行：{{msg}}', { n: f.row_no, msg: f.msg })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {report}
        <Button variant="outline" size="sm" onClick={onAgain} data-testid="import-again">
          {t('再导一批')}
        </Button>
      </div>
    </div>
  )
}
