import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper, useTable } from '@tanstack/react-table'
import { IconAlertTriangle, IconPlayerPlay, IconPlus } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { DataTable, DataTableColumnVisibility } from '@admin/ui/components/data-table'
import { QueryBar, countActive, type FilterField } from '@admin/ui/components/query-bar'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { ResetButton } from '../_shared/filters'
import { logFeatures as features } from '../_shared/log-features'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'
import { StatusPill } from '../_shared/status'
import { listState } from '../_shared/list-query'
import { useQuerySearch } from '../_shared/use-query-search'
import { useUrlColumnVisibility } from '../_shared/use-column-visibility'
import {
  SCHEDULER_TYPE_LABEL,
  describeSchedule, schedulerMetaQuery, schedulersQuery,
  useDeleteSchedulers, useRunScheduler, useToggleScheduler,
  type TaskScheduler,
} from './api'
import { SchedulerFormSheet } from './form'

export type SchedulerManageSearch = {
  page?: number
  size?: number
  name?: string
  task?: string
  enabled?: string
  hide?: string
}

const FIELDS: readonly FilterField[] = [
  { key: 'name', label: '任务名称', type: 'text', param: 'name', defaultVisible: true },
  {
    key: 'enabled',
    label: '状态',
    type: 'select',
    param: 'enabled',
    defaultVisible: true,
    options: [
      { value: 'true', label: '已启用' },
      { value: 'false', label: '已停用' },
    ],
  },
  { key: 'task', label: 'Celery 任务', type: 'text', param: 'task' },
]

const COLUMN_LABELS: Record<string, string> = {
  name: '任务名称',
  task: 'Celery 任务',
  type: '策略类型',
  schedule: '触发策略',
  enabled: '状态',
  total_run_count: '累计触发',
  last_run_time: '最近触发',
}

const col = createColumnHelper<typeof features, TaskScheduler>()

export function SchedulerManagePage({
  search = {},
  onSearchChange,
}: {
  search?: SchedulerManageSearch
  onSearchChange?: (n: SchedulerManageSearch) => void
}) {
  const { t, i18n } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const patch = React.useCallback(
    (n: Partial<SchedulerManageSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  const q = useQuerySearch({ fields: FIELDS, search, onSearchChange, keep: ['hide'] })
  const listQuery = useQuery(
    schedulersQuery({ page, size, ...(q.params as Record<string, string>) })
  )
  const { data, isFetching } = listQuery
  const list = listState(listQuery)
  const rows = data?.items ?? []

  /**
   * 🔴 指向未注册任务的调度必须在界面上**看得出来**。
   *
   * 创建时 service 层校验过任务名，但那只挡住「打错字」——任务名住在**代码**里，
   * 改个名或删掉一个任务，库里已有的调度就指向了空，而没有任何一次写操作
   * 会经过校验。之后：beat 照常派发 →「累计触发」照涨 → worker 收到一个
   * 不认识的名字只记一条 `Received unregistered task`，**不产生执行记录**。
   * 界面上这条看着在正常运行，执行记录里一条都没有 —— 而没人会去比对这两个数。
   *
   * 判断放在前端而不是让后端多下发一个字段：`/meta` 本来就要拉（表单的任务
   * 下拉用它），两份数据在同一次渲染里比对，不会出现「后端算过但过期了」。
   */
  const { data: meta } = useQuery(schedulerMetaQuery())
  const registered = React.useMemo(() => new Set(meta?.tasks ?? []), [meta])

  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<TaskScheduler | null>(null)
  const [removing, setRemoving] = React.useState<TaskScheduler | null>(null)
  const [ranId, setRanId] = React.useState<string | null>(null)

  const toggle = useToggleScheduler()
  const run = useRunScheduler()
  const remove = useDeleteSchedulers()

  const [columnVisibility, setColumnVisibility] = useUrlColumnVisibility(
    search.hide,
    React.useCallback((hide) => onSearchChange?.({ ...search, hide }), [onSearchChange, search])
  )

  const columns = React.useMemo(
    () => [
      col.accessor('name', {
        header: t('任务名称'),
        cell: ({ row, getValue }) => (
          <button
            type="button"
            data-testid={`edit-scheduler-${row.original.id}`}
            onClick={() => { setEditing(row.original); setFormOpen(true) }}
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            {getValue()}
          </button>
        ),
      }),
      col.accessor('task', {
        header: t('Celery 任务'),
        cell: ({ getValue }) => {
          const task = getValue()
          // meta 还没回来时不判 —— 否则首帧会把所有行都标成红的
          const missing = registered.size > 0 && !registered.has(task)
          return (
            <span className="flex items-center gap-1.5">
              {missing && (
                <Tooltip>
                  <TooltipTrigger
                    render={<IconAlertTriangle className="size-4 shrink-0 text-destructive" />}
                  />
                  <TooltipContent>
                    {t('这个任务没有注册 —— 调度会按时触发，但什么都不会执行')}
                  </TooltipContent>
                </Tooltip>
              )}
              <span
                data-testid={missing ? `unregistered-task-${task}` : undefined}
                className={cn(
                  'block max-w-52 truncate font-mono text-xs',
                  missing ? 'text-destructive line-through' : 'text-muted-foreground'
                )}
                title={task}
              >
                {task}
              </span>
            </span>
          )
        },
      }),
      col.accessor((r) => SCHEDULER_TYPE_LABEL[r.type] ?? '—', {
        id: 'type',
        header: t('策略类型'),
        cell: ({ getValue }) => <span className="text-sm">{t(getValue())}</span>,
      }),
      col.accessor((r) => describeSchedule(r, t, i18n.language), {
        id: 'schedule',
        header: t('触发策略'),
        // 说人话而不是显示 crontab 原文：`15 3 * * *` 对多数人不可读，
        // 而这一列的作用就是让人一眼确认「它是不是按我想的时间跑」
        cell: ({ row, getValue }) => (
          <span className="text-sm" title={row.original.crontab}>{getValue()}</span>
        ),
      }),
      col.accessor('enabled', {
        header: t('状态'),
        cell: ({ row, getValue }) => (
          <Can perm="task:scheduler:edit" fallback={
            <StatusPill tone={getValue() ? 'success' : 'muted'}>
              {t(getValue() ? '已启用' : '已停用')}
            </StatusPill>
          }>
            <Switch
              checked={getValue()}
              data-testid={`toggle-scheduler-${row.original.id}`}
              onCheckedChange={(c) => toggle.mutate({ id: row.original.id, enabled: c })}
            />
          </Can>
        ),
      }),
      col.accessor('total_run_count', {
        header: t('累计触发'),
        cell: ({ getValue }) => (
          <span className="font-mono text-xs tabular-nums">{getValue()}</span>
        ),
      }),
      col.accessor((r) => formatDateTime(r.last_run_time), {
        id: 'last_run_time',
        header: t('最近触发'),
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{getValue()}</span>
        ),
      }),
      col.display({
        id: 'actions',
        header: t('操作'),
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <Can perm="task:scheduler:run">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-8 p-0"
                      aria-label={t('立即执行一次')}
                      data-testid={`run-scheduler-${row.original.id}`}
                      onClick={async () => {
                        const id = await run.mutateAsync(row.original.id)
                        setRanId(id)
                      }}
                    />
                  }
                >
                  <IconPlayerPlay className="size-4" />
                </TooltipTrigger>
                <TooltipContent>{t('立即执行一次')}</TooltipContent>
              </Tooltip>
            </Can>
            <Can perm="task:scheduler:del">
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                data-testid={`del-scheduler-${row.original.id}`}
                onClick={() => setRemoving(row.original)}
              >
                {t('删除')}
              </Button>
            </Can>
          </div>
        ),
      }),
    ],
    [t, i18n.language, toggle, run, registered]
  )

  const table = useTable({
    features,
    data: rows,
    columns: columns as never,
    state: { columnVisibility },
    getRowId: (r: TaskScheduler) => r.id,
    manualPagination: true,
    rowCount: data?.total ?? 0,
    enableRowSelection: false,
    onColumnVisibilityChange: setColumnVisibility,
  })

  const hasFilter = countActive(q.applied, FIELDS) > 0

  return (
    // 三件套模板的外层骨架（照 pages/user/ 抄，见 pages/AGENTS.md）——
    // 之前这一页把 py-4 md:py-6 那层拆掉、gap 直接摆在 @container/main 上，
    // 于是「页头 → 查询区」少了一层竖向留白，跟别的列表页对不上
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:min-h-0 content-scroll:flex-1">
          <PageHeader title={t('任务调度')} description={t('配置定时任务的触发策略；改完立刻生效，不用重启')} />

          {/* 查询区和表格是同一个块的两半，gap-4 而不是页面级的 24px */}
          <div className="flex flex-col gap-4 content-scroll:min-h-0 content-scroll:flex-1">
            <QueryBar
              fields={FIELDS}
              value={q.value}
              onChange={q.setValue}
              onSearch={q.submit}
              onReset={q.reset}
              applied={q.applied}
              loading={isFetching}
              actions={
                <>
                  <Can perm="task:scheduler:add">
                    <Button
                      size="sm"
                      data-testid="add-scheduler"
                      onClick={() => { setEditing(null); setFormOpen(true) }}
                    >
                      <IconPlus className="size-4" />
                      {t('新增')}
                    </Button>
                  </Can>
                  <DataTableColumnVisibility table={table} columnLabels={COLUMN_LABELS} />
                </>
              }
            />

            <div
              data-testid="scheduler-manage-table"
              className="content-scroll:flex content-scroll:min-h-0 content-scroll:flex-1 content-scroll:flex-col"
            >
              <DataTable
                table={table}
                showColumnVisibility={false}
                rows={table.getRowModel().rows}
                columnCount={columns.length}
                {...list}
                skeletonRows={8}
                emptyMessage={t('还没有任务调度')}
                emptyAction={
                  hasFilter ? (
                    <ResetButton
                      variant="outline"
                      testId="empty-clear-filter"
                      label={t('清除筛选')}
                      onClick={q.reset}
                    />
                  ) : undefined
                }
                pagination={{
                  pageIndex: page - 1,
                  pageCount: data?.total_pages ?? 1,
                  pageSize: size,
                  totalCount: data?.total ?? 0,
                  onPageChange: (i) => patch({ page: i === 0 ? undefined : i + 1 }),
                  onPageSizeChange: (s) => patch({ size: s, page: undefined }),
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <SchedulerFormSheet open={formOpen} onOpenChange={setFormOpen} editing={editing} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => { if (!o) setRemoving(null) }}
        title={t('删除任务调度')}
        description={t('删除后这条调度不再触发。已经产生的执行记录会保留。')}
        confirmText={t('删除')}
        destructive
        onConfirm={async () => {
          if (removing) await remove.mutateAsync([removing.id])
          setRemoving(null)
        }}
      />

      {/* 「立即执行」是异步的 —— 接口返回 task_id 就算成功，任务本身还在队列里。
          不说清楚的话用户会以为点完就跑完了，然后去执行记录里找不到 */}
      <ConfirmDialog
        open={ranId !== null}
        onOpenChange={(o) => { if (!o) setRanId(null) }}
        title={t('已提交执行')}
        description={t('任务已进入队列，稍后可在「执行记录」里按这个 UUID 查看结果：{{id}}', { id: ranId ?? '' })}
        confirmText={t('知道了')}
        onConfirm={() => setRanId(null)}
      />
    </div>
  )
}
