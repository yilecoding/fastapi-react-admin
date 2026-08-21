import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconPencil, IconPlus, IconTrash, IconUserShield } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { StatusBadge, YesNoBadge } from '../_shared/status'
import { roleDetailQuery, roleKeys, rolesQuery, useDeleteRoles, type Role } from './api'
import { RoleFormSheet } from './form'
import { PermMatrix } from './perm-matrix'
import { RoleList } from './role-list'
import { RoleScopes } from './role-scopes'
import { RoleUsers } from './role-users'
import { DEFAULT_PAGE_SIZE } from '../_shared/pagination'

/**
 * 角色管理 —— 左角色列表 / 右授权面板的主从结构。
 *
 * 旧版是「角色表格 + 菜单授权抽屉」，配一个角色要：开抽屉 → 在树里逐个展开找按钮
 * → 存 → 关抽屉 → 换角色再来一遍。按钮权限藏在树的第三层，一个 23 个按钮的菜单
 * 要滚过 23 行才能勾完。
 *
 * 现在：角色在左边一点就换，按钮权限收在所属菜单行右侧的「已授权 n/m」里就地展开，
 * 保存按钮吸顶不跑。
 *
 * 三条硬约束照旧：
 * - 组件 router-独立，`search` / `onSearchChange` 只走 props
 * - 选中的角色、当前 tab、两个分页都写进 URL（`<Activity>` 只保会话内，刷新要靠它）
 * - ID 一律当字符串，不 Number()
 */
export type RolePageSearch = {
  page?: number
  size?: number
  name?: string
  status?: number
  /** 选中的角色 id */
  role?: string
  tab?: RoleTab
  /** 「角色用户」子表的页码 */
  upage?: number
}

export type RoleTab = 'perms' | 'scopes' | 'users'

const TABS: { value: RoleTab; label: string }[] = [
  { value: 'perms', label: '功能权限' },
  { value: 'scopes', label: '数据范围' },
  { value: 'users', label: '角色用户' },
]

export function RolePage({
  search = {},
  onSearchChange,
}: {
  search?: RolePageSearch
  onSearchChange?: (n: RolePageSearch) => void
}) {
  const { t } = useTranslation()
  const page = search.page ?? 1
  const size = search.size ?? DEFAULT_PAGE_SIZE
  const tab: RoleTab = search.tab ?? 'perms'
  const upage = search.upage ?? 1

  const patch = (n: Partial<RolePageSearch>) => onSearchChange?.({ ...search, ...n })

  const qc = useQueryClient()
  const { data, isPending, isFetching } = useQuery(
    rolesQuery({ page, size, name: search.name || undefined, status: search.status })
  )
  const roles = data?.items ?? []

  // URL 里的角色可能**不在当前页**（角色分页，30+ 个时深链常落到第 2 页之后）。
  // 只在当前页 find 会静默落回第一条 —— 那是「你以为在给角色 X 配权限、
  // 实际写的是列表第一个角色」，所以页内找不到时按 id 单独取。
  // 真的被删了（404）才落回第一条；不回写 URL，免得和导航打架。
  const inPage = roles.find((r) => r.id === search.role) ?? null
  const needLookup = Boolean(search.role) && !inPage
  const detail = useQuery({ ...roleDetailQuery(search.role ?? ''), enabled: needLookup })
  const selected =
    inPage ?? detail.data ?? (needLookup && detail.isPending ? null : (roles[0] ?? null))

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Role | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Role | null>(null)
  const [pendingSelect, setPendingSelect] = React.useState<string | null>(null)
  const del = useDeleteRoles()

  // 两个面板各自有草稿，未保存时切角色要拦一下
  const [dirtyMap, setDirtyMap] = React.useState({ perms: false, scopes: false })
  const setPermsDirty = React.useCallback(
    (d: boolean) => setDirtyMap((p) => (p.perms === d ? p : { ...p, perms: d })),
    []
  )
  const setScopesDirty = React.useCallback(
    (d: boolean) => setDirtyMap((p) => (p.scopes === d ? p : { ...p, scopes: d })),
    []
  )
  const dirty = dirtyMap.perms || dirtyMap.scopes

  function selectRole(id: string) {
    if (id === selected?.id) return
    if (dirty) setPendingSelect(id)
    else patch({ role: id, upage: undefined })
  }

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        {/*
          content-scroll:lg:* —— 内容区滚动模式 + 宽屏时，这一块撑满可用高度，
          于是下面两栏各自成为定高视区：左栏只滚角色项、右栏只滚权限行，
          角色详情头 / tab 行 / 工具条 / 表头全部钉住。
          **只在 lg 以上**：窄屏两栏是上下堆叠的，钉成定高只会把两个列表都压扁，
          那时照旧整块滚。整页滚动模式下这两条是空操作。
        */}
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6 content-scroll:lg:min-h-0 content-scroll:lg:flex-1">
          <PageHeader
            title={t("角色管理")}
            description={t("左边选角色，右边配权限。点菜单行右侧的「已授权 n/m」就地展开按钮权限，勾完直接保存。")}
          />

          {/*
            lg 以下改成上下堆叠 —— 左栏是 w-72 硬宽，横排时右栏会被压到几十像素
            （实测 390px 视口下右栏只剩 46px，内容直接被裁掉）。
            不再需要 items-start：左栏原来靠 `sticky top-4` 跟着滚，
            现在它自己就是定高的一栏，钉不钉由骨架决定。
          */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-6 content-scroll:lg:min-h-0">
            <RoleList
              roles={roles}
              total={data?.total ?? 0}
              page={page}
              size={size}
              loading={isPending}
              busy={isFetching && !isPending}
              selectedId={selected?.id ?? null}
              keyword={search.name ?? ''}
              status={search.status}
              onKeyword={(v) => patch({ name: v || undefined, page: undefined, role: undefined })}
              onStatus={(v) => patch({ status: v, page: undefined, role: undefined })}
              onReset={() => patch({ name: undefined, status: undefined, page: undefined, role: undefined })}
              onPage={(p) => patch({ page: p, role: undefined })}
              onSelect={selectRole}
              onAdd={() => { setEditing(null); setSheetOpen(true) }}
              onEdit={(r) => { setEditing(r); setSheetOpen(true) }}
              onDelete={setPendingDelete}
              onRefresh={() => qc.invalidateQueries({ queryKey: roleKeys.all })}
            />

            <div className="flex min-w-0 flex-1 flex-col gap-4 content-scroll:lg:min-h-0">
              {!selected ? (
                <EmptyDetail loading={isPending} onAdd={() => { setEditing(null); setSheetOpen(true) }} />
              ) : (
                <>
                  <RoleDetailHeader
                    role={selected}
                    onEdit={() => { setEditing(selected); setSheetOpen(true) }}
                    onDelete={() => setPendingDelete(selected)}
                  />

                  <Tabs
                    value={tab}
                    onValueChange={(v) => patch({ tab: v as RoleTab })}
                    className="min-w-0 flex-1 content-scroll:lg:min-h-0"
                  >
                    <TabsList variant="line" className="shrink-0" data-testid="role-tabs">
                      {/* ⚠️ 回调参数**不能叫 `t`** —— 会遮蔽翻译函数，
                          于是 `{t.label}` 直接渲染库里的中文，看起来还像「已经在用 t.」 */}
                      {TABS.map((item) => (
                        <TabsTrigger key={item.value} value={item.value} data-testid={`role-tab-${item.value}`}>
                          {t(item.label)}
                        </TabsTrigger>
                      ))}
                    </TabsList>

                    {/* keepMounted：切到别的 tab 再切回来，没保存的勾选还在 */}
                    {/*
                      ⚠️ display:flex 必须限定 `:not([hidden])`。Base UI 给未选中的面板
                      挂的是 `hidden` 属性（靠 UA 的 [hidden]{display:none} 生效），
                      作者样式里的 .flex 优先级更高，无条件写会把三个面板一起显示出来。
                    */}
                    <TabsContent value="perms" keepMounted className="pt-2 content-scroll:lg:min-h-0 content-scroll:lg:flex-col content-scroll:lg:[&:not([hidden])]:flex">
                      <PermMatrix key={selected.id} role={selected} onDirtyChange={setPermsDirty} />
                    </TabsContent>
                    <TabsContent value="scopes" keepMounted className="pt-2 content-scroll:lg:min-h-0 content-scroll:lg:flex-col content-scroll:lg:[&:not([hidden])]:flex">
                      <RoleScopes key={selected.id} role={selected} onDirtyChange={setScopesDirty} />
                    </TabsContent>
                    <TabsContent value="users" className="pt-2 content-scroll:lg:min-h-0 content-scroll:lg:flex-col content-scroll:lg:[&:not([hidden])]:flex">
                      <RoleUsers
                        key={selected.id}
                        role={selected}
                        page={upage}
                        onPage={(p) => patch({ upage: p })}
                      />
                    </TabsContent>
                  </Tabs>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <RoleFormSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={pendingSelect !== null}
        onOpenChange={(o) => !o && setPendingSelect(null)}
        title={t("放弃未保存的修改？")}
        description={t("当前角色有改过还没保存的授权，切走会丢掉这些改动。")}
        confirmText={t("放弃并切换")}
        destructive
        onConfirm={() => {
          if (pendingSelect) patch({ role: pendingSelect, upage: undefined })
          setPendingSelect(null)
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("删除角色")}
        description={
          pendingDelete
            ? t('确定删除角色「{{name}}」吗？已分配该角色的用户会失去对应权限。', { name: pendingDelete.name })
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
          if (wasSelected) patch({ role: undefined, upage: undefined })
        }}
      />
    </div>
  )
}

function RoleDetailHeader({
  role, onEdit, onDelete,
}: {
  role: Role
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 flex-wrap items-start justify-between gap-3" data-testid="role-detail">
      <div className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold" data-testid="role-detail-name">{role.name}</h2>
          <StatusBadge value={role.status} />
          <YesNoBadge value={role.is_filter_scopes} yes={t('按数据范围过滤')} no={t('不过滤（全量数据）')} />
        </span>
        <span className="text-xs text-muted-foreground">
          {role.remark || t('没有备注')} · {t('创建于 {{at}}', { at: role.created_time })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Can perm="sys:role:edit">
          <Button variant="outline" size="sm" className="h-8" onClick={onEdit} data-testid="role-detail-edit">
            <IconPencil className="size-4" />{t('编辑角色')}
          </Button>
        </Can>
        <Can perm="sys:role:del">
          <Button
            variant="outline" size="sm"
            className="h-8 text-destructive hover:text-destructive"
            onClick={onDelete}
            data-testid="role-detail-delete"
          >
            <IconTrash className="size-4" />{t('删除')}
          </Button>
        </Can>
      </div>
    </div>
  )
}

function EmptyDetail({ loading, onAdd }: { loading: boolean; onAdd: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-24 text-center"
         data-testid="role-empty">
      <IconUserShield className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {loading ? t('正在加载角色…') : t('左边还没有可选的角色')}
      </p>
      {!loading && (
        <Can perm="sys:role:add">
          <Button size="sm" onClick={onAdd} data-testid="role-empty-add">
            <IconPlus className="size-4" />{t('新增角色')}
          </Button>
        </Can>
      )}
    </div>
  )
}
