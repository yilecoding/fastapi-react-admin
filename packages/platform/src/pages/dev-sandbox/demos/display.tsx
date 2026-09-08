import * as React from 'react'


import { Avatar, AvatarFallback, AvatarGroup } from '@admin/ui/components/avatar'
import { Badge } from '@admin/ui/components/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@admin/ui/components/card'
import { CopyButton } from '@admin/ui/components/copy-button'
import { DescriptionItem, Descriptions } from '@admin/ui/components/descriptions'
import { Kbd, KbdGroup } from '@admin/ui/components/kbd'
import { Pagination } from '@admin/ui/components/pagination'
import { Separator } from '@admin/ui/components/separator'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@admin/ui/components/table'

import { b, jsx, lines, n, preview, s, type Demo } from '../kit'

/** 一张小表的假数据。够看出对齐、斑马纹、数字列右对齐就行 */
const ROWS = [
  { name: '张伟', dept: '研发中心', role: '管理员', cost: 128.5 },
  { name: '李娜', dept: '市场部', role: '普通用户', cost: 12.0 },
  { name: '王强', dept: '研发中心', role: '审计员', cost: 1024.75 },
]

export const DISPLAY_DEMOS: Demo[] = [
  {
    id: 'table',
    name: 'Table',
    zh: '表格原语',
    group: 'display',
    summary:
      '一层薄薄的语义封装：<table> 家族 + 统一的边框、表头底色、行 hover。它不管数据、' +
      '不管排序、不管分页 —— 那些是 DataTable 的事。容器一律 overflow-x-auto，' +
      '写 overflow-hidden 会把最右侧的操作列裁掉、点不到。',
    source: 'packages/ui/src/components/table.tsx',
    use: '行数固定、结构简单、不需要筛选分页的表：详情页里的明细、设置页里的对照表。',
    avoid: '有分页 / 筛选 / 行选中 / 取数状态的列表用 DataTable —— 那三行状态位手抄一次就漏一次（硬纪律 9）。',
    stage: 'stretch',
    knobs: {
      caption: { kind: 'bool', label: '表说明', default: false, hint: '渲染成 <caption>，读屏会先念它' },
      footer: { kind: 'bool', label: '合计行', default: false },
      numeric: { kind: 'bool', label: '数字列右对齐', default: true, hint: '配 tabular-nums，位数才对得齐' },
    },
    render: (v) => (
      <Table>
        {b(v, 'caption') && <TableCaption>本月各部门的接口调用费用</TableCaption>}
        <TableHeader>
          <TableRow>
            <TableHead>姓名</TableHead>
            <TableHead>部门</TableHead>
            <TableHead>角色</TableHead>
            <TableHead className={b(v, 'numeric') ? 'text-end' : undefined}>费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map((r) => (
            <TableRow key={r.name}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell>{r.dept}</TableCell>
              <TableCell>
                <Badge variant="outline" className="font-normal">{r.role}</Badge>
              </TableCell>
              <TableCell
                className={b(v, 'numeric') ? 'text-end font-mono tabular-nums' : undefined}
              >
                {r.cost.toFixed(2)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        {b(v, 'footer') && (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>合计</TableCell>
              <TableCell
                className={b(v, 'numeric') ? 'text-end font-mono tabular-nums' : undefined}
              >
                {ROWS.reduce((a, r) => a + r.cost, 0).toFixed(2)}
              </TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
    ),
    code: (v) =>
      jsx(
        'Table',
        {},
        lines(
          b(v, 'caption') && '<TableCaption>本月各部门的接口调用费用</TableCaption>',
          '<TableHeader>',
          '  <TableRow>',
          '    <TableHead>姓名</TableHead>',
          b(v, 'numeric')
            ? '    <TableHead className="text-end">费用</TableHead>'
            : '    <TableHead>费用</TableHead>',
          '  </TableRow>',
          '</TableHeader>',
          '<TableBody>',
          '  {rows.map((r) => (',
          '    <TableRow key={r.id}>',
          '      <TableCell className="font-medium">{r.name}</TableCell>',
          b(v, 'numeric')
            ? '      <TableCell className="text-end font-mono tabular-nums">{r.cost}</TableCell>'
            : '      <TableCell>{r.cost}</TableCell>',
          '    </TableRow>',
          '  ))}',
          '</TableBody>',
          b(v, 'footer') && '<TableFooter>…</TableFooter>'
        )
      ),
  },

  {
    id: 'descriptions',
    name: 'Descriptions',
    zh: '键值表',
    group: 'display',
    summary:
      '只读详情的「一列标签 + 一列值」。三种布局：inline（标签在左）、stacked（标签在上）、' +
      'divided（带分隔线）。mono / wrap / copy 三个开关覆盖了详情抽屉里的全部场景 —— ' +
      '在它之前，5 个 detail-sheet 各写了一份私有 Row，四份实现三种布局。',
    source: 'packages/ui/src/components/descriptions.tsx',
    use: '任何只读的键值详情：日志详情、文件属性、任务执行结果。',
    avoid: '可编辑的字段用 _shared/form-fields 的 FormField —— 它有标签、错误位和必填标记。',
    stage: 'stretch',
    knobs: {
      layout: { kind: 'select', label: '布局', options: ['inline', 'stacked', 'divided'], default: 'inline' },
      columns: { kind: 'int', label: '列数', default: 2, min: 1, max: 3, hint: '窄屏永远单列，从 sm 起才分列' },
      labelWidth: { kind: 'text', label: '标签宽', default: '4rem', hint: 'stacked 布局下忽略' },
      copy: { kind: 'bool', label: '值可复制', default: true },
    },
    rows: [
      {
        title: '三种布局',
        hint: '值短用 inline，值长（路径 / 哈希 / UA）用 stacked，行多要逐行扫读用 divided。',
        items: [
          preview({ layout: 'inline', columns: 1 }, 'inline'),
          preview({ layout: 'stacked', columns: 1 }, 'stacked'),
          preview({ layout: 'divided', columns: 1 }, 'divided'),
        ],
      },
    ],
    render: (v) => (
      <Descriptions
        layout={s(v, 'layout') as 'inline'}
        columns={n(v, 'columns') as 1}
        labelWidth={s(v, 'labelWidth')}
        className="w-full"
      >
        <DescriptionItem label="操作人" value="张伟" />
        <DescriptionItem label="操作 IP" value="10.20.30.41" mono copy={b(v, 'copy')} />
        <DescriptionItem label="耗时" value="128.5 ms" mono />
        <DescriptionItem label="状态">
          <Badge variant="outline" className="font-normal">成功</Badge>
        </DescriptionItem>
        <DescriptionItem
          label="校验和"
          value="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
          mono
          wrap
          span
          copy={b(v, 'copy')}
        />
      </Descriptions>
    ),
    code: (v) =>
      jsx(
        'Descriptions',
        {
          layout: s(v, 'layout') === 'inline' ? undefined : s(v, 'layout'),
          columns: n(v, 'columns') === 1 ? undefined : n(v, 'columns'),
          labelWidth: s(v, 'labelWidth') === '4rem' ? undefined : s(v, 'labelWidth'),
        },
        lines(
          '<DescriptionItem label="操作人" value={log.username} />',
          `<DescriptionItem label="操作 IP" value={log.ip} mono${b(v, 'copy') ? ' copy' : ''} />`,
          '<DescriptionItem label="状态">',
          '  <StatusPill tone="success">成功</StatusPill>',
          '</DescriptionItem>',
          '{/* span：长值在多列网格里独占一行 */}',
          '<DescriptionItem label="校验和" value={file.sha256} mono wrap span />'
        )
      ),
  },

  {
    id: 'pagination',
    name: 'Pagination',
    zh: '分页条',
    group: 'display',
    summary:
      '全站唯一一份分页条。pageIndex 是 0 起的（跟 TanStack Table 对齐），显示时 +1。' +
      '它以前焊死在 DataTable 和 data-grid 内部各一份，两份的每页选项、页码文案、' +
      '翻译接法全不一样 —— 同一个产品里有两种分页条。',
    source: 'packages/ui/src/components/pagination.tsx',
    use: '任何服务端分页的列表。DataTable / DataGrid 已经内置了它，只有手写列表（宫格、卡片流）才要自己摆。',
    avoid: '「回第一页」要写 page: undefined 不是 page: 1 —— 写字面量 1 会让 ?page=1 出现在每个列表页的地址栏。',
    stage: 'stretch',
    knobs: {
      page: { kind: 'int', label: '当前页（1 起）', default: 3, min: 1, max: 9 },
      pageCount: { kind: 'int', label: '总页数', default: 9, min: 1, max: 99 },
      pageSize: { kind: 'int', label: '每页', default: 20, min: 10, max: 50 },
      totalCount: { kind: 'int', label: '总条数', default: 173, min: 0, max: 9999 },
      selected: { kind: 'bool', label: '显示已选数', default: false, hint: '只读列表不传，那时只显示总条数' },
    },
    render: (v) => (
      <PaginationDemo
        key={`${n(v, 'page')}-${n(v, 'pageCount')}-${n(v, 'pageSize')}`}
        page={n(v, 'page')}
        pageCount={n(v, 'pageCount')}
        pageSize={n(v, 'pageSize')}
        totalCount={n(v, 'totalCount')}
        selected={b(v, 'selected')}
      />
    ),
    code: (v) =>
      jsx('Pagination', {
        pageIndex: '{pageIndex}',
        pageCount: '{pageCount}',
        pageSize: '{pageSize}',
        totalCount: '{totalCount}',
        selectedCount: b(v, 'selected') ? '{Object.keys(rowSelection).length}' : undefined,
        onPageChange: '{(i) => patch({ page: i === 0 ? undefined : i + 1 })}',
        onPageSizeChange: '{(size) => patch({ size, page: undefined })}',
      }),
  },

  {
    id: 'separator',
    name: 'Separator',
    zh: '分隔线',
    group: 'display',
    summary:
      '一条语义化的分隔线（渲染成 role="separator"）。横向撑满、纵向自适应父高度 —— ' +
      '纵向那条要求父级是 flex 且有确定高度，否则它是 0 高、看不见。',
    source: 'packages/ui/src/components/separator.tsx',
    use: '同一块内容里的分组：菜单里的动作分组、工具栏里的功能分区、详情里的小节标题尾巴。',
    avoid: '两块之间的距离靠 gap-* 表达就够时不要加线 —— 线是「这两组有区别」，不是「这里要留白」。',
    knobs: {
      orientation: { kind: 'select', label: 'orientation', options: ['horizontal', 'vertical'], default: 'horizontal' },
    },
    render: (v) =>
      s(v, 'orientation') === 'vertical' ? (
        <div className="flex h-8 items-center gap-3 text-sm">
          <span>已启用</span>
          <Separator orientation="vertical" />
          <span>12 条规则</span>
          <Separator orientation="vertical" />
          <span>2 分钟前</span>
        </div>
      ) : (
        <div className="flex w-64 flex-col gap-3 text-sm">
          <span>基本信息</span>
          <Separator />
          <span>高级设置</span>
        </div>
      ),
    code: (v) =>
      s(v, 'orientation') === 'vertical'
        ? lines(
            '{/* 纵向的要父级 flex + 有确定高度，否则是 0 高 */}',
            '<div className="flex h-8 items-center gap-3">',
            '  <span>已启用</span>',
            '  <Separator orientation="vertical" />',
            '  <span>12 条规则</span>',
            '</div>'
          )
        : '<Separator />',
  },

  {
    id: 'kbd',
    name: 'Kbd',
    zh: '快捷键',
    group: 'display',
    summary:
      '快捷键提示。KbdGroup 把几个键排成一组（⌘ K）。它自带 in-data-[slot=tooltip-content] 的配色，' +
      '所以塞进 tooltip 里不用再调颜色。',
    source: 'packages/ui/src/components/kbd.tsx',
    use: '命令面板、菜单项右侧、图标按钮的 tooltip 里 —— 任何「这个动作有快捷键」的地方。',
    avoid: 'Kbd 是 pointer-events-none 的纯提示，不要往上挂 onClick。',
    knobs: {
      keys: { kind: 'text', label: '按键（空格分隔）', default: '⌘ K' },
      inTooltip: { kind: 'bool', label: '放进 tooltip 配色', default: false, hint: '模拟深色底上的样子' },
    },
    rows: [
      {
        title: '常见组合',
        hint: 'Mac 用符号（⌘ ⇧ ⌥），Windows 写全称（Ctrl Shift Alt）—— 平台判断在调用方。',
        items: [
          preview({ keys: '⌘ K' }, '命令面板'),
          preview({ keys: '⌘ ⇧ P' }, '三键'),
          preview({ keys: 'Ctrl S' }, 'Windows'),
          preview({ keys: 'Esc' }, '单键'),
        ],
      },
    ],
    render: (v) => {
      const keys = s(v, 'keys').split(/\s+/).filter(Boolean)
      const group = (
        <KbdGroup>
          {keys.map((k, i) => (
            <Kbd key={`${k}-${i}`}>{k}</Kbd>
          ))}
        </KbdGroup>
      )
      return b(v, 'inTooltip') ? (
        <span
          data-slot="tooltip-content"
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs text-background"
        >
          打开命令面板
          {group}
        </span>
      ) : (
        group
      )
    },
    code: (v) =>
      jsx(
        'KbdGroup',
        {},
        s(v, 'keys')
          .split(/\s+/)
          .filter(Boolean)
          .map((k) => `<Kbd>${k}</Kbd>`)
          .join('\n')
      ),
  },

  {
    id: 'copy-button',
    name: 'CopyButton',
    zh: '复制按钮',
    group: 'display',
    summary:
      '复制到剪贴板，成功给 1.4 秒的对勾回执 —— 不弹 toast，复制的反馈应该在原地。' +
      '🔴 内置了 document.execCommand 兜底：navigator.clipboard 只在安全上下文（https / localhost）下存在，' +
      '而局域网 http 访问后台是这类系统最常见的部署形态。',
    source: 'packages/ui/src/components/copy-button.tsx',
    use: 'ID、UUID、trace、IP、哈希、URL —— 任何「存在的意义就是被粘到别处」的值旁边。',
    avoid: '要复制的是一整块内容（JSON、异常栈）时把它绝对定位到块的右上角，别挤在文字后面。',
    knobs: {
      text: { kind: 'text', label: '要复制的内容', default: '2049629108245233664' },
      label: { kind: 'text', label: 'aria-label', default: '', hint: '不给就是「复制」' },
    },
    render: (v) => (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1">
        <code className="font-mono text-xs tabular-nums">{s(v, 'text')}</code>
        <CopyButton text={s(v, 'text')} label={s(v, 'label') || undefined} />
      </span>
    ),
    code: (v) =>
      jsx('CopyButton', {
        text: '{log.trace_id}',
        label: s(v, 'label') || undefined,
      }),
  },

  {
    id: 'avatar',
    name: 'Avatar',
    zh: '头像',
    group: 'display',
    summary: '有图用 AvatarImage，没图落回 AvatarFallback（取名字首字）。多人用 AvatarGroup 叠。',
    source: 'packages/ui/src/components/avatar.tsx',
    use: '用户 / 实体的头像，取不到图时回落到首字母。',
    avoid: '纯装饰性图片直接 <img>，不用套 Avatar 的回落逻辑。',
    rows: [
      {
        title: '尺寸与成组',
        hint: 'AvatarGroup 会把头像叠起来，用在「这条记录关联了哪几个人」。',
        items: [
          preview({ mode: '单个', size: 'size-8' }, 'size-8'),
          preview({ mode: '单个', size: 'size-9' }, 'size-9'),
          preview({ mode: '单个', size: 'size-12' }, 'size-12'),
          preview({ mode: '一组', size: 'size-9' }, 'group'),
        ],
      },
    ],
    knobs: {
      mode: { kind: 'select', label: '形态', options: ['单个', '一组'], default: '单个' },
      size: { kind: 'select', label: '尺寸', options: ['size-8', 'size-9', 'size-12'], default: 'size-9' },
    },
    render: (v) => {
      const size = s(v, 'size')
      if (s(v, 'mode') === '一组')
        return (
          <AvatarGroup>
            {['管', '李', '王'].map((t) => (
              <Avatar key={t} className={size}>
                <AvatarFallback>{t}</AvatarFallback>
              </Avatar>
            ))}
          </AvatarGroup>
        )
      return (
        <Avatar className={size}>
          <AvatarFallback>管</AvatarFallback>
        </Avatar>
      )
    },
    code: (v) => {
      const inner = jsx('Avatar', { className: s(v, 'size') }, '<AvatarFallback>管</AvatarFallback>')
      return s(v, 'mode') === '一组' ? jsx('AvatarGroup', {}, inner) : inner
    },
  },
  {
    id: 'card',
    name: 'Card',
    zh: '卡片',
    group: 'display',
    summary:
      '一块有边界的内容。列表页不要用它包表格 —— DataTable 自己就有容器；卡片是给指标、说明这类东西的。',
    source: 'packages/ui/src/components/card.tsx',
    use: '把一组相关内容围起来：指标卡、设置分区、列表项。',
    avoid: '页面级的块间距靠 gap-4 md:gap-6，不要靠给每块套 Card 制造间距。',
    rows: [
      {
        title: '组合',
        hint: '指标卡只要标题 + 数字；有说明才加 CardDescription。分隔线是给「头身内容性质不同」时用的。',
        items: [
          preview({ description: false, badge: false, separator: false }, '最小'),
          preview({ description: true, badge: false, separator: false }, '带描述'),
          preview({ description: true, badge: true, separator: false }, '带徽标'),
          preview({ description: true, badge: true, separator: true }, '带分隔线'),
        ],
      },
    ],
    knobs: {
      description: { kind: 'bool', label: '带描述', default: true },
      badge: { kind: 'bool', label: '带徽标', default: false },
      separator: { kind: 'bool', label: '头身之间加分隔线', default: false },
    },
    render: (v) => (
      <Card className="w-72">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            在线会话
            {b(v, 'badge') && <Badge variant="secondary">实时</Badge>}
          </CardTitle>
          {b(v, 'description') && <CardDescription>扫 Redis 的 token 键，一次全给。</CardDescription>}
        </CardHeader>
        {b(v, 'separator') && <Separator />}
        <CardContent className="text-2xl font-semibold tabular-nums">12</CardContent>
      </Card>
    ),
    code: (v) =>
      jsx(
        'Card',
        {},
        lines(
          '<CardHeader>',
          '  <CardTitle>在线会话</CardTitle>',
          b(v, 'description') && '  <CardDescription>说明文案</CardDescription>',
          '</CardHeader>',
          b(v, 'separator') && '<Separator />',
          '<CardContent>12</CardContent>'
        )
      ),
  },
  {
    id: 'badge',
    name: 'Badge',
    zh: '徽标',
    group: 'display',
    summary:
      '短状态标签。**业务状态（正常/停用）不要在这里手搭** —— 走 pages/_shared/status.tsx 的 StatusBadge，色板只在那一处定义。',
    source: 'packages/ui/src/components/badge.tsx',
    use: '一小段状态 / 分类标记：角色名、HTTP 方法、数量。',
    avoid: '系统通用的「正常 / 停用」用 _shared/status 的 StatusBadge —— 状态色只有那一处定义。',
    knobs: {
      variant: {
        kind: 'select',
        label: 'variant',
        options: ['default', 'secondary', 'outline', 'destructive', 'ghost', 'link'],
        default: 'secondary',
      },
      children: { kind: 'text', label: '文案', default: '待审核' },
    },
    rows: [
      {
        title: '变体',
        hint: 'secondary 是默认选择；default 那么重的底色一屏出现十几个就成噪音了。',
        items: [
          preview({ variant: 'default', children: 'default' }),
          preview({ variant: 'secondary', children: 'secondary' }),
          preview({ variant: 'outline', children: 'outline' }),
          preview({ variant: 'destructive', children: 'destructive' }),
          preview({ variant: 'ghost', children: 'ghost' }),
        ],
      },
      {
        title: '真实用法',
        hint: '徽标里的数字要 tabular-nums，否则一列数字宽窄跳动。',
        items: [
          preview({ variant: 'secondary', children: '待审核' }),
          preview({ variant: 'outline', children: 'v1.0.0' }),
          preview({ variant: 'destructive', children: '已停用' }),
          preview({ variant: 'secondary', children: '12' }),
        ],
      },
    ],
    render: (v) => (
      <Badge variant={s(v, 'variant') as 'default'} className="tabular-nums">
        {s(v, 'children')}
      </Badge>
    ),
    code: (v) =>
      jsx(
        'Badge',
        { variant: s(v, 'variant') === 'default' ? undefined : s(v, 'variant') },
        s(v, 'children')
      ),
  },
]

/**
 * 分页条要有「当前页」这个状态才演示得出来 —— 而 demo 的 render 是个纯函数，
 * 拿不到 hook。所以把状态包进一个小组件里，旋钮值只当**初始值**。
 *
 * ⚠️ 用 key 让旋钮改动重置内部状态：旋钮把「总页数」从 9 调到 3 时，
 * 内部的 pageIndex 还停在 8，分页条会显示「第 9 / 3 页」。
 */
function PaginationDemo({
  page,
  pageCount,
  pageSize,
  totalCount,
  selected,
}: {
  page: number
  pageCount: number
  pageSize: number
  totalCount: number
  selected: boolean
}) {
  const [index, setIndex] = React.useState(page - 1)
  const [size, setSize] = React.useState(pageSize)
  return (
    <Pagination
      className="w-full"
      pageIndex={Math.min(index, Math.max(0, pageCount - 1))}
      pageCount={pageCount}
      pageSize={size}
      totalCount={totalCount}
      selectedCount={selected ? 3 : undefined}
      onPageChange={setIndex}
      onPageSizeChange={setSize}
    />
  )
}
