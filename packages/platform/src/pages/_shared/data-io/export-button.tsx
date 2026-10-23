import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { IconDownload, IconHistory, IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { toast } from '@admin/ui/components/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { EXPORT_STATUS, downloadExport, useStartExport, type ExportFormat } from './api'

/**
 * 导出（#11 · v0.4）：选格式、选范围，**文件由后端生成**。
 *
 * 原来两个日志页是「前端按页拉全量、拼 CSV」：拉到 20 页就停（4,000 行之后**静默截断**），
 * 日志里 `=…` 开头的用户名原样进了 CSV（公式注入），而用户 / 部门这些最常被要求导出的页面根本没有。
 * 现在：
 *
 * - 筛选参数**原样**交给后端（和列表接口同名），所以「导出的就是列表看到的那批」——
 *   拼错一个参数名后端会**拒绝**，不是忽略（忽略 = 导出全表，而用户以为是筛过的）
 * - 小批量当场生成、直接下载；大批量转后台，生成完发站内消息，记录在「个人中心 → 导出记录」
 * - 选了行就多一个「只导出选中的」
 * - 列是**资源定义的全量字段**，不是表格上看得见的那几列：导出里有编码、ID 这些表格不显示的列，
 *   正是它们让「导出 → 改 → 原样导回」成立（后端的 `columns` 入参还在，要按列表的样子裁剪时再接）
 *
 * ⚠️ 不用 `disabled` 挡重复点击（图标按钮一禁用 hover 就打不开 tooltip，见 ui 分册）：
 * `aria-busy` + `run()` 里的重入守卫
 */
export function ExportButton({
  path,
  filters,
  selectedIds = [],
  total,
  iconOnly = false,
  testId = 'export',
}: {
  /** 导出接口，如 `/api/v1/sys/users/export` */
  path: string
  /** 当前的筛选条件，**列表接口的入参**（不含 page / size） */
  filters: Record<string, unknown>
  selectedIds?: string[]
  /** 当前筛选下的总条数，写进菜单项里（「导出当前筛选结果（N 条）」） */
  total?: number
  /** 日志页那种工具行：只留图标 + tooltip */
  iconOnly?: boolean
  testId?: string
}) {
  const { t } = useTranslation()
  const start = useStartExport(path)
  const [format, setFormat] = React.useState<ExportFormat>('xlsx')

  async function run(scope: 'filtered' | 'selected') {
    if (start.isPending) return
    try {
      const job = await start.mutateAsync({
        format,
        filters: Object.fromEntries(
          Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '')
        ),
        // 选中的行也带着筛选条件：两者取交集，选中项本来就在当前筛选里（换筛选会清选中）
        ids: scope === 'selected' ? selectedIds : undefined,
      })
      if (job.status === EXPORT_STATUS.succeeded) {
        await downloadExport(job)
        toast.success(t('已导出 {{n}} 条', { n: job.row_count ?? job.total }))
      } else {
        toast.info(
          t('数据较多（{{n}} 条），已转入后台生成。完成后会发站内消息，也可以在「个人中心 → 导出记录」里查看。', {
            n: job.total,
          }),
          { timeout: 8000 }
        )
      }
    } catch (e) {
      // 硬纪律 9：失败要说出来。最常见的是「超过单次上限」「没有符合条件的数据」—— 都是要用户改条件的
      toast.error(e instanceof Error ? e.message : t('导出失败'))
    }
  }

  const busy = start.isPending
  const icon = busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconDownload className="size-4" />
  const trigger = (
    <DropdownMenuTrigger
      render={
        <Button
          size="sm"
          variant="outline"
          className={iconOnly ? 'size-8 p-0' : undefined}
          aria-busy={busy}
          aria-label={iconOnly ? t('导出') : undefined}
          data-testid={testId}
        />
      }
    >
      {icon}
      {iconOnly ? null : t('导出')}
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>{busy ? t('导出中…') : t('导出')}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('文件格式')}</DropdownMenuLabel>
          {/* 选格式不关菜单（RadioItem 默认 closeOnClick=false）：选完还要点下面的「导出」 */}
          <DropdownMenuRadioGroup value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
            {/* 格式名不过 t()：两种语言写法一样，而纯 ASCII 的 key 会被 i18n:check 判成孤儿删掉（见 file/api.ts formatBytes） */}
            <DropdownMenuRadioItem value="xlsx" data-testid={`${testId}-format-xlsx`}>
              Excel (.xlsx)
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="csv" data-testid={`${testId}-format-csv`}>
              CSV (.csv)
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem data-testid={`${testId}-filtered`} onClick={() => void run('filtered')}>
            <IconDownload />
            {total === undefined
              ? t('导出当前筛选结果')
              : t('导出当前筛选结果（{{n}} 条）', { n: total })}
          </DropdownMenuItem>
          {selectedIds.length > 0 ? (
            <DropdownMenuItem data-testid={`${testId}-selected`} onClick={() => void run('selected')}>
              <IconDownload />
              {t('只导出选中的 {{n}} 条', { n: selectedIds.length })}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem
          render={<Link to="/profile" search={{ section: 'exports' }} />}
          data-testid={`${testId}-history`}
        >
          <IconHistory />
          {t('导出记录')}
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
