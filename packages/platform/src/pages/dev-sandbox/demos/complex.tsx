import * as React from 'react'
import {
  IconDatabase,
  IconFileText,
  IconLayoutDashboard,
  IconSettings,
  IconShieldLock,
  IconUsers,
} from '@tabler/icons-react'
import {
  columnVisibilityFeature,
  createColumnHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { CommandPalette, type CommandItem } from '@admin/ui/components/command-palette'
import { DataTable } from '@admin/ui/components/data-table'
import {
  DateTimeRangePicker,
  DateTimeValuePicker,
  type RangeValue,
} from '@admin/ui/components/datetime-picker'
import { MultiSelect, type MultiSelectOption } from '@admin/ui/components/multi-select'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from '@admin/ui/components/sidebar'
import { Tree, type TreeNode } from '@admin/ui/components/tree'
import { cn } from '@admin/ui/lib/utils'

import { buildSelectColumn } from '../../_shared/select-column'
import { StatusPill } from '../../_shared/status'
import { b, jsx, lines, preview, s, type Demo, type KnobValues } from '../kit'

/**
 * 「**demo 需要一层带 state 的外壳**」的那一批。
 *
 * ⚠️ 文件名不决定层级 —— **层级看每个 demo 自己的 `group`**（见 kit.ts 的 TIERS）。
 * 这里面既有复杂组件（DataTable 要 TanStack table 实例、Tree 要受控选中态、
 * CommandPalette 要条目清单、FileViewer 要带鉴权取回的字节），
 * 也有两个**基础**组件：MultiSelect 和 DateTimePicker ——
 * 它们本身是「props 进、DOM 出」的自包含件，只是**受控**，
 * demo 里得有人替它拿住 value。
 *
 * 判据别混：「demo 要不要 state 外壳」是这个文件的收纳规则，
 * 「拿走之后要接多少东西」才是 tier 的判据。
 */

// ─── DataTable 的假表 ─────────────────────────────────────────────────────────

type Person = {
  id: string
  name: string
  dept: string
  role: string
  status: 0 | 1
  lastLogin: string
}

const PEOPLE: Person[] = [
  { id: '1', name: '林舟', dept: '平台体验组', role: '管理员', status: 1, lastLogin: '2026-09-04 09:12' },
  { id: '2', name: '陈曜', dept: '交易增长组', role: '开发者', status: 1, lastLogin: '2026-09-03 18:40' },
  { id: '3', name: '周澈', dept: '风险策略组', role: '审计员', status: 0, lastLogin: '2026-08-21 11:05' },
  { id: '4', name: '许安', dept: '客户运营组', role: '只读', status: 1, lastLogin: '2026-09-04 08:01' },
  { id: '5', name: '沈南', dept: '基础架构组', role: '开发者', status: 1, lastLogin: '2026-09-02 22:31' },
]

const tableFeats = tableFeatures({
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
})

const personCol = createColumnHelper<typeof tableFeats, Person>()

// ─── 树的假数据 ───────────────────────────────────────────────────────────────

const TREE: TreeNode[] = [
  {
    id: 'system',
    label: '系统管理',
    searchText: '系统管理',
    children: [
      { id: 'system.user', label: '用户管理', searchText: '用户管理' },
      { id: 'system.role', label: '角色管理', searchText: '角色管理' },
      {
        id: 'system.menu',
        label: '菜单管理',
        searchText: '菜单管理',
        children: [
          { id: 'system.menu.add', label: '新增菜单', searchText: '新增菜单' },
          { id: 'system.menu.del', label: '删除菜单', searchText: '删除菜单' },
        ],
      },
    ],
  },
  {
    id: 'log',
    label: '日志管理',
    searchText: '日志管理',
    children: [
      { id: 'log.login', label: '登录日志', searchText: '登录日志' },
      { id: 'log.opera', label: '操作日志', searchText: '操作日志', disabled: true },
    ],
  },
]

const DEPT_OPTIONS: MultiSelectOption[] = [
  { value: 'platform', label: '平台体验组' },
  { value: 'growth', label: '交易增长组' },
  { value: 'risk', label: '风险策略组', hint: '需要审计权限' },
  { value: 'ops', label: '客户运营组' },
  { value: 'infra', label: '基础架构组' },
  { value: 'data', label: '数据平台组', disabled: true },
]

export const COMPLEX_DEMOS: Demo[] = [
  {
    id: 'data-table',
    name: 'DataTable',
    zh: '列表表格',
    group: 'table',
    summary:
      '列表页的表格外壳：工具栏槽 + 表头 + 表体 + 分页条，自带加载 / 后台刷新 / 失败 / 空态四种状态。' +
      '它不持有数据 —— table 实例和 rows 由调用方给，所以服务端分页和前端分页用的是同一个外壳。',
    source: 'packages/ui/src/components/data-table.tsx',
    use: '所有服务端分页的 CRUD 列表页。取数状态一律从 _shared/list-query 的 listState() 摊开传进来。',
    avoid: '🔴 error 传了才不会把失败伪装成空态（硬纪律 9）。别把错误落进 emptyMessage —— 那和「筛选太窄」长得一模一样。',
    stage: 'stretch',
    knobs: {
      state: {
        kind: 'select',
        label: '状态',
        options: ['正常', '首屏加载', '后台刷新', '取数失败', '失败但有旧数据', '空列表'],
        default: '正常',
        hint: '四种状态是这个组件存在的主要理由',
      },
      select: { kind: 'bool', label: '行选中', default: true, hint: '开了就必须有复选框列，否则「已选 N 项」永远是 0' },
      pagination: { kind: 'bool', label: '分页条', default: true },
      columns: { kind: 'bool', label: '「列」下拉', default: true, hint: '和 QueryBar 合并时关掉' },
      actions: { kind: 'bool', label: '主动作', default: true, hint: '新增 / 导出，放工具栏右侧' },
    },
    rows: [
      {
        title: '🔴 失败不是空态',
        hint: '同一张表的两种「没东西看」：左边是接口挂了（有重试入口），右边是真的没数据。混成一种，用户会一直改筛选。',
        items: [
          preview({ state: '取数失败' }, 'error'),
          preview({ state: '空列表' }, 'empty'),
        ],
      },
    ],
    render: (v) => <DataTableDemo v={v} />,
    code: (v) =>
      lines(
        '// 状态位一次摊开，页面只管 rows —— 少写一个就是类型错误',
        'const listQuery = useQuery(usersQuery(params))',
        'const list = listState(listQuery)',
        '',
        jsx('DataTable', {
          table: '{table}',
          rows: '{table.getRowModel().rows}',
          columnCount: '{columns.length}',
          '...list': true,
          showColumnVisibility: b(v, 'columns') ? undefined : '{false}',
          actions: b(v, 'actions') ? '{<Button size="sm"><IconPlus />新增</Button>}' : undefined,
          pagination: b(v, 'pagination') ? '{{ pageIndex, pageCount, pageSize, totalCount, onPageChange, onPageSizeChange }}' : undefined,
          emptyAction: '{<Button variant="outline" onClick={clearFilters}>清除筛选</Button>}',
        }),
        '',
        b(v, 'select')
          ? '// 开了行选中就必须有复选框列：columns[0] = buildSelectColumn(col, {}, t)'
          : '// 只读列表：enableRowSelection: false，否则分页条上的「已选 N 项」永远是 0'
      ),
  },

  {
    id: 'multi-select',
    name: 'MultiSelect',
    zh: '多选下拉',
    group: 'form',
    summary:
      '关闭态刻意**不铺 chips** —— 筛选栏一行 32px，铺三个就换行。' +
      '1 项显示 label、多项显示「label +n」，完整清单靠下拉里的勾选态。下拉底部有「全选 / 清空」。',
    source: 'packages/ui/src/components/multi-select.tsx',
    use: '要选多个的地方：筛选栏里的部门 / 角色、表单里的多对多关联。',
    avoid: '只选一个用 Select（≤ 8 项）或 Combobox（长列表）。选项超过几百条时它没有虚拟化，考虑改成「搜索 + 已选清单」两段式。',
    knobs: {
      size: { kind: 'select', label: 'size', options: ['sm', 'default'], default: 'sm', hint: '筛选栏一行是 32px = sm' },
      searchable: { kind: 'bool', label: '可搜索', default: true },
      showBulk: { kind: 'bool', label: '全选 / 清空', default: true },
      placeholder: { kind: 'text', label: 'placeholder', default: '选择部门' },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    render: (v) => <MultiSelectDemo v={v} />,
    code: (v) =>
      jsx('MultiSelect', {
        value: '{value}',
        onValueChange: '{setValue}',
        options: '{DEPT_OPTIONS}',
        size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
        placeholder: s(v, 'placeholder'),
        searchable: b(v, 'searchable') ? undefined : '{false}',
        showBulk: b(v, 'showBulk') ? undefined : '{false}',
        disabled: b(v, 'disabled') || undefined,
        'aria-label': '选择部门',
      }),
  },

  {
    id: 'datetime-picker',
    name: 'DateTimePicker',
    zh: '时间选择',
    group: 'form',
    summary:
      '两个组件：DateTimeValuePicker（单个时刻）和 DateTimeRangePicker（区间，自带今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 上月）。' +
      '🔴 值是**本地时间串**（`2026-09-04 08:00:00`）不是 Date —— 它要原样进 URL 和接口入参，' +
      'Date 序列化成 ISO 会带上时区偏移，回来时又要解析一次，中间任何一步漏了都是「差 8 小时」。',
    source: 'packages/ui/src/components/datetime-picker.tsx',
    use: '筛选栏的时间范围、表单里的生效时间。区间几乎总是「近 N 天」，所以 presets 默认开。',
    avoid: '显示服务端时间不要用它 —— 那走 @admin/i18n 的 formatDateTime，时区口径只有那一处。',
    knobs: {
      mode: { kind: 'select', label: '形态', options: ['单值', '区间'], default: '区间' },
      withTime: { kind: 'bool', label: '带时分秒', default: false, hint: '关掉时区间自动补 00:00:00 / 23:59:59' },
      presets: { kind: 'bool', label: '快捷区间', default: true, hint: '只对区间有效' },
      size: { kind: 'select', label: 'size', options: ['sm', 'default'], default: 'sm' },
    },
    render: (v) => <DateTimeDemo v={v} />,
    code: (v) =>
      s(v, 'mode') === '区间'
        ? jsx('DateTimeRangePicker', {
            value: '{[from, to]}',
            onChange: '{(r) => patch({ from: r?.[0], to: r?.[1], page: undefined })}',
            withTime: b(v, 'withTime') || undefined,
            presets: b(v, 'presets') ? undefined : '{false}',
            size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
            'aria-label': '登录时间',
          })
        : jsx('DateTimeValuePicker', {
            value: '{value}',
            onChange: '{setValue}',
            withTime: b(v, 'withTime') || undefined,
            size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
            'aria-label': '生效时间',
          }),
  },

  {
    id: 'tree',
    name: 'Tree',
    zh: '树形多选',
    group: 'composite',
    summary:
      '受控树 + 三态复选：勾父节点级联选中全部子孙，部分选中显示半选。' +
      '输出的是**扁平的 id 数组**，直接喂后端。shadcn / Base UI 生态里没有现成的树形多选，这是手写的。',
    source: 'packages/ui/src/components/tree.tsx',
    use: '需要「树 + 三态复选」的授权类界面：菜单授权、部门范围。',
    avoid: '🔴 角色授权**不用它** —— 权限矩阵（role/perm-matrix.tsx）把按钮收在菜单行右侧的芯片里就地展开，不铺成树的叶子行。别把两套合并了再说。',
    stage: 'stretch',
    knobs: {
      cascade: { kind: 'bool', label: '级联子孙', default: true, hint: '关掉就是「节点独立」模式，勾得出孤儿' },
      preset: { kind: 'select', label: '初始选中', options: ['无', '部分（看半选）', '一整支'], default: '部分（看半选）' },
    },
    render: (v) => <TreeDemo v={v} />,
    code: (v) =>
      lines(
        'const [checked, setChecked] = React.useState<string[]>([])',
        '',
        jsx('Tree', {
          nodes: '{nodes}',
          checked: '{checked}',
          onCheckedChange: '{setChecked}',
          cascade: b(v, 'cascade') ? undefined : '{false}',
        }),
        '',
        b(v, 'cascade')
          ? '// 级联模式下 checked 只含**被显式勾选**的节点，父节点的半选不在里面'
          : '// ⚠️ 节点独立模式勾得出孤儿（子选了、父没选），侧边栏会挂不上去 —— 界面要提示'
      ),
  },

  {
    id: 'command-palette',
    name: 'CommandPalette',
    zh: '命令面板',
    group: 'composite',
    summary:
      'Dialog + 受控列表 + 子序列打分，手写的。打分规则按「用户敲的是缩写」定：' +
      '`sjqx` 能命中「数据权限」的路由 `/system/data-permission`（连续段更高分），而 `限权` 不该命中「权限」—— ' +
      '所以是**顺序**子序列，不是「包含全部字符」。',
    source: 'packages/ui/src/components/command-palette.tsx',
    use: '全局搜索 / 快捷跳转。业务组装在 platform/shell/command-menu.tsx，这里只是外壳。',
    avoid: '不要为它重新引 cmdk，也不要用 Combobox 套进 Dialog —— 后者是「触发器 + 浮层」的选值控件，两层焦点管理会互相抢。',
    knobs: {
      groups: { kind: 'bool', label: '分组', default: true },
      hint: { kind: 'bool', label: '第二行说明', default: true, hint: '菜单层级链 / 路由地址' },
      footer: { kind: 'bool', label: '底部提示条', default: true },
    },
    render: (v) => <CommandPaletteDemo v={v} />,
    code: (v) =>
      lines(
        'const items: CommandItem[] = pages.map((p) => ({',
        '  id: p.path,',
        `  label: p.title,${b(v, 'hint') ? '' : ''}`,
        b(v, 'hint') ? '  hint: p.breadcrumb,           // 第二行的弱化说明' : '',
        b(v, 'groups') ? "  group: '页面'," : "  group: '',",
        '  keywords: p.path,               // 参与匹配但不显示',
        '  onSelect: () => navigate({ to: p.path }),',
        '}))',
        '',
        jsx('CommandPalette', {
          open: '{open}',
          onOpenChange: '{setOpen}',
          items: '{items}',
          footer: b(v, 'footer') ? '{<KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>}' : undefined,
        })
      ),
  },

  {
    id: 'sidebar',
    name: 'Sidebar',
    zh: '侧边栏',
    group: 'composite',
    summary:
      '一整套外壳：Provider（收起/展开状态 + 移动端抽屉）、Sidebar、Header/Content/Footer、' +
      '两级菜单按钮、徽标、骨架。业务侧的菜单树装配在 platform/shell/ 里。',
    source: 'packages/ui/src/components/sidebar.tsx',
    use: '应用主导航。收起态、移动端抽屉、键盘快捷键都在 SidebarProvider 里，不用自己接。',
    avoid: '🔴 同一层级必须用同一套按钮组件（硬纪律 8）：顶层 SidebarMenuButton、子层 SidebarMenuSubButton。同层里混用，缩进必然错位。',
    stage: 'stretch',
    knobs: {
      nested: { kind: 'bool', label: '展开子菜单', default: true },
      badge: { kind: 'bool', label: '徽标', default: true, hint: '未读数这种' },
      icons: { kind: 'bool', label: '图标', default: true },
    },
    render: (v) => <SidebarDemo v={v} />,
    code: (v) =>
      lines(
        '<SidebarProvider>',
        '  <Sidebar>',
        '    <SidebarContent>',
        '      <SidebarGroup>',
        '        <SidebarGroupLabel>系统管理</SidebarGroupLabel>',
        '        <SidebarMenu>',
        '          <SidebarMenuItem>',
        '            {/* 🔴 顶层用 SidebarMenuButton */}',
        `            <SidebarMenuButton isActive>${b(v, 'icons') ? '<IconUsers />' : ''}用户管理</SidebarMenuButton>`,
        b(v, 'badge') ? '            <SidebarMenuBadge>12</SidebarMenuBadge>' : '',
        b(v, 'nested') ? '            <SidebarMenuSub>' : '',
        b(v, 'nested') ? '              <SidebarMenuSubItem>' : '',
        b(v, 'nested') ? '                {/* 🔴 子层用 SidebarMenuSubButton，不要靠 ps-* 手动补缩进 */}' : '',
        b(v, 'nested') ? '                <SidebarMenuSubButton>登录日志</SidebarMenuSubButton>' : '',
        b(v, 'nested') ? '              </SidebarMenuSubItem>' : '',
        b(v, 'nested') ? '            </SidebarMenuSub>' : '',
        '          </SidebarMenuItem>',
        '        </SidebarMenu>',
        '      </SidebarGroup>',
        '    </SidebarContent>',
        '  </Sidebar>',
        '</SidebarProvider>'
      ),
  },

  {
    id: 'file-viewer',
    name: 'FileViewer',
    zh: '文件预览',
    group: 'composite',
    summary:
      '按扩展名挑 renderer（图片 / PDF / Office / 文本 / 压缩包）。' +
      '🔴 喂 **buffer**（带鉴权取回的字节）不喂 url —— 直接给 url 等于让 renderer 自己发一个不带 Authorization 头的请求，' +
      '拿回来的是 401 的 JSON。而且只在 Dialog 里挂，别常驻页面：renderer 要测容器尺寸，' +
      '隐藏页签是 display:none、宽度为 0（recharts 已经因为同一个原因被删掉了）。',
    source: 'packages/ui/src/components/file-viewer/index.tsx',
    use: '文件管理、附件列表的「预览」。业务壳在 pages/file/preview-dialog.tsx。',
    avoid: '沙箱里跑不起来 —— 它要真实字节。这一条只说清楚契约，实际效果去「文件管理」页点预览。',
    stage: 'stretch',
    knobs: {
      kind: {
        kind: 'select',
        label: '文件类型',
        options: ['图片', 'PDF', 'Word', '表格', '文本', '压缩包', '不支持'],
        default: 'PDF',
      },
    },
    render: (v) => <FileViewerContract kind={s(v, 'kind')} />,
    code: () =>
      lines(
        '// 🔴 带鉴权取字节，不能用 <a href download> —— 那带不上 Authorization 头',
        'const buffer = await fetchBytes(`/sys/files/${id}/download`)',
        '',
        '<Dialog open={open} onOpenChange={setOpen}>',
        '  <DialogContent className="max-w-4xl">',
        '    {/* 只在 Dialog 里挂：renderer 要测容器尺寸，隐藏页签宽度是 0 */}',
        '    <FileViewer buffer={buffer} filename={file.original_name} />',
        '  </DialogContent>',
        '</Dialog>'
      ),
  },
]

// ─── 带状态的 demo 外壳 ───────────────────────────────────────────────────────

function DataTableDemo({ v }: { v: KnobValues }) {
  const state = s(v, 'state')
  const [rowSelection, setRowSelection] = React.useState<Record<string, true>>({ '2': true })
  const [columnVisibility, setColumnVisibility] = React.useState({})
  const [pageIndex, setPageIndex] = React.useState(0)

  const empty = state === '空列表'
  const error =
    state === '取数失败' || state === '失败但有旧数据'
      ? Object.assign(new Error('服务器开小差了'), { httpStatus: 500 })
      : null
  // 「失败但有旧数据」= placeholderData 还留着上一次成功的行，错误改挂横幅
  const data = empty || state === '取数失败' ? [] : PEOPLE

  const columns = React.useMemo(() => {
    const list: unknown[] = []
    if (b(v, 'select')) list.push(buildSelectColumn(personCol as never))
    list.push(
      personCol.accessor('name', { header: '姓名', cell: (c) => c.getValue() }),
      personCol.accessor('dept', { header: '部门', cell: (c) => c.getValue() }),
      personCol.accessor('role', {
        header: '角色',
        cell: (c) => (
          <Badge variant="outline" className="font-normal">
            {c.getValue()}
          </Badge>
        ),
      }),
      personCol.accessor('status', {
        header: '状态',
        cell: (c) => (
          <StatusPill tone={c.getValue() === 1 ? 'success' : 'danger'}>
            {c.getValue() === 1 ? '正常' : '停用'}
          </StatusPill>
        ),
      }),
      personCol.accessor('lastLogin', {
        header: '最近登录',
        cell: (c) => <span className="font-mono text-xs tabular-nums">{c.getValue()}</span>,
      })
    )
    return list as never[]
  }, [v])

  const table = useTable({
    features: tableFeats,
    data,
    columns,
    getRowId: (r: Person) => r.id,
    enableRowSelection: b(v, 'select'),
    state: { rowSelection, columnVisibility },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
  })

  return (
    <DataTable
      table={table as never}
      rows={table.getRowModel().rows as never}
      columnCount={columns.length}
      loading={state === '首屏加载'}
      busy={state === '后台刷新'}
      error={error}
      onRetry={() => {}}
      showColumnVisibility={b(v, 'columns')}
      emptyMessage="没有匹配的用户"
      emptyAction={
        <Button variant="outline" size="sm">
          清除筛选
        </Button>
      }
      actions={
        b(v, 'actions') ? (
          <Button size="sm" data-testid="sandbox-dt-add">
            新增
          </Button>
        ) : undefined
      }
      pagination={
        b(v, 'pagination')
          ? {
              pageIndex,
              pageCount: 9,
              pageSize: 20,
              totalCount: 173,
              selectedCount: b(v, 'select') ? Object.keys(rowSelection).length : undefined,
              onPageChange: setPageIndex,
              onPageSizeChange: () => {},
            }
          : undefined
      }
    />
  )
}

function MultiSelectDemo({ v }: { v: KnobValues }) {
  const [value, setValue] = React.useState<string[]>(['platform', 'growth'])
  return (
    <div className="w-64">
      <MultiSelect
        value={value}
        onValueChange={setValue}
        options={DEPT_OPTIONS}
        size={s(v, 'size') as 'sm'}
        placeholder={s(v, 'placeholder')}
        searchable={b(v, 'searchable')}
        showBulk={b(v, 'showBulk')}
        disabled={b(v, 'disabled')}
        aria-label="选择部门"
      />
    </div>
  )
}

function DateTimeDemo({ v }: { v: KnobValues }) {
  const [single, setSingle] = React.useState<string | undefined>(undefined)
  const [range, setRange] = React.useState<RangeValue | undefined>(undefined)
  const withTime = b(v, 'withTime')
  const size = s(v, 'size') as 'sm'

  return (
    <div className="flex w-72 flex-col gap-2">
      {s(v, 'mode') === '区间' ? (
        <DateTimeRangePicker
          value={range}
          onChange={setRange}
          withTime={withTime}
          presets={b(v, 'presets')}
          size={size}
          aria-label="登录时间"
        />
      ) : (
        <DateTimeValuePicker
          value={single}
          onChange={setSingle}
          withTime={withTime}
          size={size}
          aria-label="生效时间"
        />
      )}
      {/* 把真实的值打出来 —— 「它到底存的是什么」正是这个组件最容易搞错的地方 */}
      <code className="rounded bg-muted/50 px-2 py-1 font-mono text-2xs break-all text-muted-foreground">
        {s(v, 'mode') === '区间'
          ? JSON.stringify(range ?? null)
          : JSON.stringify(single ?? null)}
      </code>
    </div>
  )
}

function TreeDemo({ v }: { v: KnobValues }) {
  const preset = s(v, 'preset')
  const initial =
    preset === '一整支'
      ? ['log', 'log.login', 'log.opera']
      : preset === '部分（看半选）'
        ? ['system.user', 'system.menu.add']
        : []
  const [checked, setChecked] = React.useState<string[]>(initial)

  // 旋钮改初始值时要重置 —— 否则「初始选中」这个旋钮看起来是坏的
  const [seen, setSeen] = React.useState(preset)
  if (seen !== preset) {
    setSeen(preset)
    setChecked(initial)
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <Tree
        nodes={TREE}
        checked={checked}
        onCheckedChange={setChecked}
        cascade={b(v, 'cascade')}
        className="max-h-64 w-full overflow-y-auto overflow-x-hidden rounded-lg border border-border p-2"
      />
      <code className="rounded bg-muted/50 px-2 py-1 font-mono text-2xs break-all text-muted-foreground">
        checked = {JSON.stringify(checked)}
      </code>
    </div>
  )
}

function CommandPaletteDemo({ v }: { v: KnobValues }) {
  const [open, setOpen] = React.useState(false)
  const [picked, setPicked] = React.useState<string | null>(null)
  const grouped = b(v, 'groups')
  const withHint = b(v, 'hint')

  const items: CommandItem[] = React.useMemo(
    () =>
      [
        { id: '/dashboard', label: '仪表盘', hint: '/dashboard', group: '页面', icon: <IconLayoutDashboard /> },
        { id: '/system/user', label: '用户管理', hint: '系统管理 › 用户管理', group: '页面', icon: <IconUsers /> },
        { id: '/system/data-permission', label: '数据权限', hint: '/system/data-permission', group: '页面', icon: <IconShieldLock /> },
        { id: '/log/login', label: '登录日志', hint: '日志管理 › 登录日志', group: '页面', icon: <IconFileText /> },
        { id: 'act:reload', label: '重新加载当前页', hint: '丢弃页面内状态', group: '动作', icon: <IconSettings /> },
        { id: 'act:cache', label: '清空本地缓存', hint: '不影响服务端', group: '动作', icon: <IconDatabase /> },
      ].map((it) => ({
        ...it,
        hint: withHint ? it.hint : undefined,
        group: grouped ? it.group : '',
        keywords: it.id,
        onSelect: () => setPicked(it.label),
      })),
    [grouped, withHint]
  )

  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="sandbox-cmd-open">
        打开命令面板
      </Button>
      <p className="text-xs text-muted-foreground">
        {picked ? `选中了「${picked}」` : '试试敲 sjqx —— 顺序子序列能命中「数据权限」的路由'}
      </p>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        items={items}
        footer={b(v, 'footer') ? <span>↑↓ 选择 · ⏎ 确认 · Esc 关闭</span> : undefined}
      />
    </div>
  )
}

function SidebarDemo({ v }: { v: KnobValues }) {
  const icons = b(v, 'icons')
  return (
    // 侧边栏平时是 fixed 定位铺满视口的，塞进舞台要框一层受限的盒子
    <div className="h-80 w-full overflow-hidden rounded-lg border border-border">
      <SidebarProvider className="min-h-0 h-full">
        <Sidebar collapsible="none" className="h-full border-e border-border">
          <SidebarHeader className="px-3 py-2 text-sm font-semibold">中后台</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>系统管理</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  {/* 🔴 顶层一律 SidebarMenuButton（硬纪律 8） */}
                  <SidebarMenuButton isActive>
                    {icons && <IconUsers />}
                    用户管理
                  </SidebarMenuButton>
                  {b(v, 'badge') && <SidebarMenuBadge>12</SidebarMenuBadge>}
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>
                    {icons && <IconShieldLock />}
                    角色管理
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>日志管理</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton>
                    {icons && <IconFileText />}
                    日志
                  </SidebarMenuButton>
                  {b(v, 'nested') && (
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        {/* 🔴 子层一律 SidebarMenuSubButton，不要靠 ps-* 手动补齐 */}
                        <SidebarMenuSubButton>登录日志</SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton>操作日志</SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </div>
  )
}

/** 支持哪些扩展名、以及为什么必须喂 buffer —— 沙箱里没有真实字节可喂 */
const VIEWER_KINDS: Record<string, { ext: string; renderer: string; ok: boolean }> = {
  图片: { ext: 'png · jpg · gif · webp · svg', renderer: '@file-viewer/renderer-image', ok: true },
  PDF: { ext: 'pdf', renderer: '@file-viewer/renderer-pdf', ok: true },
  Word: { ext: 'docx', renderer: '@file-viewer/renderer-word', ok: true },
  表格: { ext: 'xlsx · csv', renderer: '@file-viewer/renderer-spreadsheet', ok: true },
  文本: { ext: 'txt · md · json · log', renderer: '@file-viewer/renderer-text', ok: true },
  压缩包: { ext: 'zip', renderer: '@file-viewer/renderer-archive', ok: true },
  不支持: { ext: '其它一切', renderer: '回落到「不支持预览」+ 下载入口', ok: false },
}

function FileViewerContract({ kind }: { kind: string }) {
  const meta = VIEWER_KINDS[kind] ?? VIEWER_KINDS['不支持']!
  return (
    <div className="flex w-full flex-col gap-3">
      <div
        className={cn(
          'flex flex-col gap-1.5 rounded-lg border border-dashed p-4 text-sm',
          meta.ok ? 'border-border bg-muted/20' : 'border-amber-500/40 bg-amber-500/5'
        )}
      >
        <span className="font-medium">{kind}</span>
        <span className="font-mono text-xs text-muted-foreground">{meta.ext}</span>
        <span className="text-xs text-muted-foreground">→ {meta.renderer}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        沙箱里**不渲染真实预览** —— 它要带鉴权取回的字节，而这里没有。
        实际效果去「文件管理」页点预览；这一条 demo 的用处是把契约说清楚：
        喂 <code className="font-mono">buffer</code> 不喂 url、只在 Dialog 里挂。
      </p>
    </div>
  )
}
