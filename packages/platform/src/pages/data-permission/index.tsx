import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconDatabaseCog, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'

import { formatDateTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'

import { Can } from '../../auth/can'
import {
  DropdownMenuItem, DropdownMenuSeparator,
} from '@admin/ui/components/dropdown-menu'
import { listState } from '../_shared/list-query'
import { MasterList, type MasterListItem } from '../_shared/master-list'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { StatusBadge } from '../_shared/status'
import { dataScopesInfiniteQuery, scopeDetailQuery, scopeKeys, useDeleteDataScopes, type DataScope } from './api'
import { RulesPanel } from './rules-panel'
import { ScopeFormSheet } from './scope-form'

/**
 * 数据权限 —— 由原来的「数据范围」+「数据规则」两个菜单合并而来。
 *
 * 为什么合：`filter_data_permission` 把所有范围里的规则拍平成一个 set，
 * 范围在运行时**不构成任何查询边界**，它只是一捆规则的名字，好让角色有东西可绑。
 * 而规则表虽然是 m2m，实测零复用（19 条规则没有一条挂在两个范围上）。
 *
 * 于是拆两页的代价是纯亏的：加一个条件要走「数据规则 → 新增 → 数据范围 → 配置规则
 * → 找到它 → 勾上 → 保存」四屏，中途忘了勾就留下一条谁也看不见的孤儿规则
 * （合并前库里已经躺着一条）。合成主从页后，「新建规则」建完直接挂上，一步。
 *
 * 表结构没动：`sys_data_rule` + `sys_data_scope_rule` 仍是 m2m。
 * 现在没人复用不代表以后不会，合并 UI 免费且可逆，改表不是。
 */
export type DataPermissionPageSearch = {
  // 左栏走滚动加载，所以**没有** page/size —— 加回来就必须同时加分页条
  name?: string
  status?: number
  /** 选中的数据范围 id */
  scope?: string
}

export function DataPermissionPage({
  search = {},
  onSearchChange,
}: {
  search?: DataPermissionPageSearch
  onSearchChange?: (n: DataPermissionPageSearch) => void
}) {
  const { t } = useTranslation()

  const patch = (n: Partial<DataPermissionPageSearch>) => onSearchChange?.({ ...search, ...n })

  const qc = useQueryClient()
  const listQuery = useInfiniteQuery(
    dataScopesInfiniteQuery({ name: search.name || undefined, status: search.status })
  )
  const {
    data, isPending, hasNextPage, isFetchingNextPage, fetchNextPage,
  } = listQuery
  // 取数状态位统一从这里出 —— 少解构一个 `error` 就是把失败画成空态（硬纪律 9）
  const list = listState(listQuery)
  // 已取回的所有页拍平 —— 滚动加载里没有「当前页」
  const scopes = React.useMemo(() => data?.pages.flatMap((pg) => pg.items) ?? [], [data])
  const total = data?.pages[0]?.total ?? 0

  const scopeItems = React.useMemo<MasterListItem[]>(
    () => scopes.map((x) => ({ id: x.id, title: x.name, status: x.status })),
    [scopes]
  )

  // URL 里的范围可能**不在当前页**（范围分页，深链常落到第 2 页之后）。
  // 只在当前页 find 会静默落回第一条 —— 那是「你以为在给范围 X 配规则、
  // 实际写的是列表第一个范围」，所以页内找不到时按 id 单独取（同 role/index.tsx）。
  // 真的被删了（404）才落回第一条；不回写 URL，免得和导航打架。
  const inPage = scopes.find((s) => s.id === search.scope) ?? null
  const needLookup = Boolean(search.scope) && !inPage
  const detail = useQuery({ ...scopeDetailQuery(search.scope ?? ''), enabled: needLookup })
  const selected =
    inPage ?? detail.data ?? (needLookup && detail.isPending ? null : (scopes[0] ?? null))

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<DataScope | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<DataScope | null>(null)
  const del = useDeleteDataScopes()

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/* 主从页的滚动骨架，三种情形三套行为 —— 见 CLAUDE.md「主从页」一节 */}
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:lg:min-h-0 content-scroll:lg:flex-1">
          <PageHeader
            title={t("数据权限")}
            description={t("左边是数据范围（一捆规则的名字，角色绑的就是它），右边是这个范围下的具体条件。")}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-6 content-scroll:lg:min-h-0">
            {/* 与角色页同一个左栏件 */}
            <MasterList
              idPrefix="scope"
              title={t('数据范围')}
              items={scopeItems}
              total={total}
              selectedId={selected?.id ?? null}
              onSelect={(id) => patch({ scope: id })}
              keyword={search.name ?? ''}
              searchPlaceholder="搜索范围名称…"
              onKeyword={(v) => patch({ name: v || undefined, scope: undefined })}
              status={search.status}
              onStatus={(v) => patch({ status: v, scope: undefined })}
              onReset={() => patch({ name: undefined, status: undefined, scope: undefined })}
              hasMore={hasNextPage}
              loadingMore={isFetchingNextPage}
              {...list}
              onLoadMore={() => void fetchNextPage()}
              onAdd={() => { setEditing(null); setSheetOpen(true) }}
              addLabel={t('新增数据范围')}
              addPerm="data:scope:add"
              onRefresh={() => void qc.invalidateQueries({ queryKey: scopeKeys.all })}
              emptyText={t('没有匹配的数据范围')}
              renderActions={(item) => {
                const scope = scopes.find((x) => x.id === item.id)
                if (!scope) return null
                return (
                  <>
                    <Can perm="data:scope:edit">
                      <DropdownMenuItem onClick={() => { setEditing(scope); setSheetOpen(true) }}>
                        <IconPencil className="size-4" />{t('编辑')}
                      </DropdownMenuItem>
                    </Can>
                    <Can perm="data:scope:del">
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(scope)}>
                        <IconTrash className="size-4" />{t('删除')}
                      </DropdownMenuItem>
                    </Can>
                  </>
                )
              }}
            />

            <div className="flex min-w-0 flex-1 flex-col gap-4 content-scroll:lg:min-h-0">
              {!selected ? (
                <EmptyDetail loading={isPending} onAdd={() => { setEditing(null); setSheetOpen(true) }} />
              ) : (
                <>
                  <div className="flex shrink-0 flex-wrap items-start justify-between gap-3" data-testid="scope-detail">
                    <div className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold" data-testid="scope-detail-name">{selected.name}</h2>
                        <StatusBadge value={selected.status} />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('创建于 {{at}}', { at: formatDateTime(selected.created_time) })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Can perm="data:scope:edit">
                        <Button variant="outline" size="sm" className="h-8"
                                onClick={() => { setEditing(selected); setSheetOpen(true) }}
                                data-testid="scope-detail-edit">
                          <IconPencil className="size-4" />{t('编辑范围')}
                        </Button>
                      </Can>
                      <Can perm="data:scope:del">
                        <Button
                          variant="outline" size="sm"
                          className="h-8 text-destructive hover:text-destructive"
                          onClick={() => setPendingDelete(selected)}
                          data-testid="scope-detail-delete"
                        >
                          <IconTrash className="size-4" />{t('删除')}
                        </Button>
                      </Can>
                    </div>
                  </div>

                  <RulesPanel key={selected.id} scope={selected} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <ScopeFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("删除数据范围")}
        description={
          pendingDelete
            ? t('删除范围「{{name}}」？绑了它的角色会失去这部分数据权限。范围里的规则本身保留，可以挂到别的范围上。', { name: pendingDelete.name })
            : ''
        }
        confirmText={t("删除")}
        destructive
        pending={del.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return
          const wasSelected = pendingDelete.id === selected?.id
          await del.mutateAsync([pendingDelete.id])
          setPendingDelete(null)
          if (wasSelected) patch({ scope: undefined })
        }}
      />
    </div>
  )
}

function EmptyDetail({ loading, onAdd }: { loading: boolean; onAdd: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-24 text-center"
         data-testid="scope-empty">
      <IconDatabaseCog className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {loading ? t('正在加载数据范围…') : t('左边还没有可选的数据范围')}
      </p>
      {!loading && (
        <Can perm="data:scope:add">
          <Button size="sm" onClick={onAdd} data-testid="scope-empty-add">
            <IconPlus className="size-4" />{t('新增数据范围')}
          </Button>
        </Can>
      )}
    </div>
  )
}
