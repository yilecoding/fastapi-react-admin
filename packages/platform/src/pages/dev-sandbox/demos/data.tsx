import { IconChartBar, IconKey, IconUsers } from '@tabler/icons-react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@admin/ui/components/accordion'
import { Avatar, AvatarFallback, AvatarGroup } from '@admin/ui/components/avatar'
import { Badge } from '@admin/ui/components/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@admin/ui/components/card'
import { Separator } from '@admin/ui/components/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { b, jsx, lines, preview, s, type Demo } from '../kit'
import { DataGridDemo } from './data-grid-demo'
import { QueryBarDemo } from './query-bar-demo'
import { RichTextDemo } from './rich-text-demo'

export const DATA_DEMOS: Demo[] = [
  {
    id: 'query-bar',
    name: 'QueryBar',
    zh: '查询区',
    group: 'data',
    summary:
      '列表页顶部那块查询区。字段声明式配置、默认不铺满、按需「添加条件」、显式点搜索才发请求。' +
      '高级模式能表达 (A 且 B) 或 C —— 基础模式的平铺 AND 永远表达不了。' +
      '值由调用方持有（受控），页面负责把它写进 URL；组件只自己存「筛选视图」这种个人偏好。',
    source: 'packages/ui/src/components/query-bar/index.tsx',
    stage: 'stretch',
    knobs: {
      mode: { kind: 'select', label: '初始模式', options: ['basic', 'advanced'], default: 'basic' },
      fields: {
        kind: 'int', label: '可筛字段数', default: 14, min: 2, max: 14,
        hint: '「添加条件」里能挑到的。14 = 12 种字段类型全摆一个',
      },
      visible: {
        kind: 'select', label: '默认铺开', options: ['按声明', '一个都不铺', '全部铺开'],
        default: '按声明', hint: 'defaultVisible 的才一进页面就摆出来',
      },
      collapse: {
        kind: 'int', label: '折叠阈值', default: 8, min: 2, max: 14,
        hint: '超过这么多格就收起来，避免把表格顶下去',
      },
      advanced: { kind: 'bool', label: '允许高级模式', default: true, hint: '后端没有过滤 DSL 时别开' },
      views: { kind: 'bool', label: '筛选视图', default: true, hint: '另存为 / 覆盖 / 重命名 / 设默认，存 localStorage' },
      actions: { kind: 'bool', label: '左侧页面动作', default: true, hint: '「新增 / 导出 / 列」这类按钮塞在 actions 槽' },
    },
    rows: [
      {
        title: '两种模式',
        hint: '基础是一排 [字段|值] 隐含 AND；高级是可嵌套的条件树，每条自己选运算符。',
        items: [
          preview({ mode: 'basic' }, '基础筛选'),
          preview({ mode: 'advanced', visible: '一个都不铺' }, '高级筛选'),
        ],
      },
      {
        title: '默认铺不铺',
        hint: '一个都不铺 = 查询区一进来是空的，全靠「添加条件」；常用字段才值得 defaultVisible。',
        items: [
          preview({ mode: 'basic', visible: '一个都不铺', views: false, actions: false }, '一个都不铺'),
          preview({ mode: 'basic', visible: '全部铺开', views: false, actions: false, collapse: 14 }, '全部铺开'),
        ],
      },
      {
        title: '12 种字段类型',
        hint:
          '文本 · 数字 · 单选 · 多选 · 是否 · 日期 · 日期区间 · 日期时间 · 日期时间区间 · 时间 · 标签 · 自定义。' +
          '时间类给的是「快捷区间 + 日历 + 时分秒」，多选是带复选框的可搜索下拉，标签能粘贴一整列。',
        items: [
          preview({ mode: 'basic', visible: '全部铺开', collapse: 14, views: false, actions: false }, '全铺开看一遍'),
        ],
      },
    ],
    render: (v) => <QueryBarDemo v={v} />,
    code: (v) =>
      lines(
        'const FIELDS: FilterField[] = [',
        "  { key: 'name', label: '姓名', type: 'text', defaultVisible: true, showOperator: true },",
        "  { key: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },",
        "  { key: 'role', label: '角色', type: 'multiSelect', options: ROLE_OPTIONS },",
        "  { key: 'score', label: '评分', type: 'number', defaultOperator: 'between', min: 0, max: 100 },",
        "  // 一个字段 → 两个入参，名字由接口定",
        "  { key: 'createdAt', label: '创建时间', type: 'dateTimeRange',",
        "    rangeParams: ['start_time', 'end_time'], defaultVisible: true },",
        ']',
        '',
        jsx('QueryBar', {
          fields: '{FIELDS}',
          value: '{query}',
          onChange: '{setQuery}',
          onSearch: '{(v) => patch({ ...toSearchParams(v, FIELDS), q: packQuery(v) })}',
          advanced: b(v, 'advanced') || undefined,
          viewsStorageKey: b(v, 'views') ? 'qb:users' : undefined,
        }),
        '',
        '// toSearchParams 出平铺入参（给接口 + 好看的地址栏），',
        '// packQuery 出整份查询（连「摆了哪几格」和高级模式的树一起存）',
        b(v, 'advanced')
          ? '// 高级模式给的是条件树：toFilterTree(v) —— 后端得先支持过滤语法'
          : ''
      ),
  },
  {
    id: 'rich-text',
    name: 'RichText',
    zh: '富文本',
    group: 'data',
    summary:
      'Tiptap（ProseMirror）编辑器，输出 HTML 字符串，直接落 NVARCHAR(MAX) 列。' +
      '只读渲染用 RichTextViewer 而不是 dangerouslySetInnerHTML —— 它走同一套 schema 解析，' +
      'script / onerror / javascript: 链接在解析阶段就被丢掉，比事后过滤可靠。' +
      '图片能力靠注入（ui 不能 import platform）：不传 images 就整块关掉，' +
      '传了才有插图按钮、才接粘贴与拖拽。正文里存的是相对直链 /uploads/… 加 data-file-id，' +
      '不是 base64 也不是 blob —— 前者会把列表接口的响应灌爆，后者活不过一次刷新。',
    source: 'packages/ui/src/components/rich-text/index.tsx',
    stage: 'stretch',
    knobs: {
      mode: { kind: 'select', label: '形态', options: ['editor', 'viewer'], default: 'editor', hint: 'viewer 是发布后的样子' },
      height: { kind: 'select', label: '编辑区高度', options: ['32', '48', '64'], default: '48' },
      limit: { kind: 'bool', label: '字数上限', default: false, hint: '限 500 字，超了敲不进去' },
      images: { kind: 'bool', label: '图片能力', default: true, hint: '关掉就没有插图按钮、粘贴图片也不上传' },
      disabled: { kind: 'bool', label: '禁用', default: false },
      showOutput: { kind: 'bool', label: '显示出参', default: true, hint: 'HTML 与纯文本摘要' },
    },
    rows: [
      {
        title: '编辑与阅读',
        hint: '两者共用同一套 schema 和排版类 —— 编辑时看到的必须和发布后一致。',
        items: [
          preview({ mode: 'editor', height: '32', showOutput: false }, '编辑器'),
          preview({ mode: 'viewer' }, '只读视图'),
        ],
      },
      {
        title: '图片：能力是注入的',
        hint:
          '截图可以直接 Ctrl+V 粘进来，也能拖文件进去。上传中是一个 widget decoration 占位 —— ' +
          '它不进文档，所以传到一半点保存不会把「转圈的假节点」存进库。' +
          '从 Word / 网页粘来的外链图会被剥掉并给提示（浏览器里转存不了，CORS 挡着）。' +
          '关掉这一档就是「没有图片能力」的样子：按钮不渲染，粘贴回落成浏览器默认行为。',
        items: [
          preview({ mode: 'editor', images: true, height: '48', showOutput: true }, '开：可插图 / 可粘贴'),
          preview({ mode: 'editor', images: false, height: '48', showOutput: false }, '关：工具栏没有插图按钮'),
        ],
      },
    ],
    render: (v) => <RichTextDemo v={v} />,
    code: (v) =>
      s(v, 'mode') === 'viewer'
        ? lines(
            '// 详情页/抽屉里渲染正文',
            jsx('RichTextViewer', { value: '{notice.content}' }),
            '',
            '// 列表页的摘要列要剥标签，否则一列全是尖括号',
            'const preview = (html: string) => richTextToPlain(html, 60)'
          )
        : lines(
            '// 表单里不能用 form.register —— 那是给原生 input 的，',
            '// 富文本给的是 HTML 字符串，走受控 watch/setValue',
            jsx('RichTextEditor', {
              value: '{content}',
              onChange: "{(html) => form.setValue('content', html, { shouldDirty: true })}",
              minHeight: `min-h-${s(v, 'height')}`,
              maxLength: b(v, 'limit') ? 500 : undefined,
              disabled: b(v, 'disabled') || undefined,
              images: b(v, 'images') ? '{images}' : undefined,
            }),
            b(v, 'images') &&
              lines(
                '',
                '// images 由 platform 注入 —— ui 永远不 import platform',
                'const images = useRichTextImages()',
                '',
                '// 保存后还要把正文里的图挂上关联，否则删了这条记录',
                '// 那些图会永远留在磁盘和「文件管理」里，没人知道是谁的',
                'await syncImages(id, body.content)'
              )
          ),
  },

  {
    id: 'data-grid',
    name: 'DataGrid',
    zh: '数据表格',
    group: 'data',
    summary:
      '全能力表格外壳：密度、固定列、行置顶、行内展开、右键菜单、批量浮条、虚拟滚动。' +
      '组件不持有业务状态 —— 列定义、feature 注册、筛选分页都在调用方，所以同一个 grid ' +
      '既能配服务端分页也能配全量滚动。分组/排序/拖拽这些可调项更多，去 /sandbox/table 那个实验台。',
    source: 'packages/ui/src/components/data-grid/index.tsx',
    stage: 'stretch',
    knobs: {
      density: { kind: 'select', label: '密度', options: ['compact', 'standard', 'loose'], default: 'standard', hint: '也可以在表格工具栏里切' },
      rows: { kind: 'int', label: '数据量', default: 24, min: 3, max: 200, hint: '超过 20 行且开虚拟滚动才会真正虚拟化' },
      striped: { kind: 'bool', label: '斑马纹', default: false },
      bordered: { kind: 'bool', label: '边框', default: true },
      select: { kind: 'bool', label: '多选列', default: true },
      rowNumber: { kind: 'bool', label: '序号列', default: true, hint: '服务端分页要传 offset 才能跨页连续' },
      expand: { kind: 'bool', label: '展开列', default: true, hint: '配 renderSubRow 用' },
      pinActions: { kind: 'bool', label: '固定操作列', default: true, hint: 'columnPinning 的 end；治「操作列被裁掉点不到」' },
      footer: { kind: 'bool', label: '页脚聚合', default: false },
      contextMenu: { kind: 'bool', label: '右键菜单', default: true },
      bulkBar: { kind: 'bool', label: '批量浮条', default: true, hint: '选中行后从底部浮出' },
      keyboard: { kind: 'bool', label: '键盘导航', default: false, hint: '点一下表格再按方向键' },
      virtual: { kind: 'bool', label: '虚拟滚动', default: false, hint: '打开后接管滚动，分页条隐藏' },
    },
    render: (v) => <DataGridDemo v={v} />,
    code: (v) =>
      lines(
        'const table = useTable({ features, data, columns, state, ...handlers })',
        '',
        jsx('DataGrid', {
          table: '{table}',
          storageKey: 'grid:users',
          defaultDensity: s(v, 'density') === 'standard' ? undefined : s(v, 'density'),
          defaultStriped: b(v, 'striped') || undefined,
          defaultBordered: b(v, 'bordered') ? undefined : 'false',
          showFooter: b(v, 'footer') || undefined,
          keyboardNav: b(v, 'keyboard') || undefined,
        }, lines(
          b(v, 'virtual') ? 'virtual={{ enabled: true, threshold: 20, overscan: 8, maxHeight: 360 }}' : '',
          b(v, 'contextMenu') ? 'contextMenu={(row) => <RowMenu row={row} />}' : '',
          b(v, 'expand') ? 'renderSubRow={(row) => <Detail row={row} />}' : '',
          b(v, 'bulkBar') ? 'bulkActions={(rows) => <Button>批量删除</Button>}' : '',
          b(v, 'virtual') ? '' : 'pagination={{ pageIndex, pageCount, pageSize, totalCount, onPageChange, onPageSizeChange }}'
        ).split('\n').filter(Boolean).join('\n')),
        '',
        '// 列由调用方给，这几根柱子有现成的：',
        lines(
          b(v, 'select') ? 'buildGridSelectColumn(col)' : '',
          b(v, 'rowNumber') ? 'buildGridRowNumberColumn(col, { offset: (page - 1) * size })' : '',
          b(v, 'expand') ? 'buildGridExpandColumn(col)' : ''
        ),
        b(v, 'pinActions')
          ? "// 操作列固定在末尾：state.columnPinning = { start: [], end: ['actions'] }"
          : ''
      ),
  },
  {
    id: 'tabs',
    name: 'Tabs',
    zh: '页签',
    group: 'data',
    summary:
      'default 是胶囊，line 是下划线。主从页的面板要配 keepMounted，否则切走再回来草稿就没了。',
    source: 'packages/ui/src/components/tabs.tsx',
    rows: [
      {
        title: '变体',
        hint: 'default 是胶囊组（自成一块），line 是下划线（贴着内容顶边）。同一屏里别混用。',
        items: [
          preview({ variant: 'default', icon: false }, 'default'),
          preview({ variant: 'line', icon: false }, 'line'),
          preview({ variant: 'default', icon: true }, 'default + 图标'),
          preview({ variant: 'line', icon: true }, 'line + 图标'),
        ],
      },
    ],
    knobs: {
      variant: { kind: 'select', label: 'variant', options: ['default', 'line'], default: 'default' },
      icon: { kind: 'bool', label: '带图标', default: false },
    },
    render: (v) => (
      <Tabs defaultValue="perms" className="w-80">
        <TabsList variant={s(v, 'variant') as 'default'}>
          <TabsTrigger value="perms">
            {b(v, 'icon') && <IconKey />}
            菜单权限
          </TabsTrigger>
          <TabsTrigger value="scopes">
            {b(v, 'icon') && <IconChartBar />}
            数据范围
          </TabsTrigger>
          <TabsTrigger value="users">
            {b(v, 'icon') && <IconUsers />}
            成员
          </TabsTrigger>
        </TabsList>
        <TabsContent value="perms" className="pt-3 text-muted-foreground">
          勾菜单和按钮。
        </TabsContent>
        <TabsContent value="scopes" className="pt-3 text-muted-foreground">
          配这个角色能看到哪些行。
        </TabsContent>
        <TabsContent value="users" className="pt-3 text-muted-foreground">
          这个角色下的人。
        </TabsContent>
      </Tabs>
    ),
    code: (v) =>
      jsx(
        'Tabs',
        { defaultValue: 'perms' },
        lines(
          jsx(
            'TabsList',
            { variant: s(v, 'variant') === 'default' ? undefined : s(v, 'variant') },
            lines(
              `<TabsTrigger value="perms">${b(v, 'icon') ? '<IconKey />' : ''}菜单权限</TabsTrigger>`,
              `<TabsTrigger value="scopes">${b(v, 'icon') ? '<IconChartBar />' : ''}数据范围</TabsTrigger>`
            )
          ),
          '<TabsContent value="perms" keepMounted>…</TabsContent>',
          '<TabsContent value="scopes" keepMounted>…</TabsContent>'
        )
      ),
  },

  {
    id: 'accordion',
    name: 'Accordion',
    zh: '折叠面板',
    group: 'data',
    summary: '长表单分段、或一屏放不下的说明。defaultValue 是数组，可以同时展开多项。',
    source: 'packages/ui/src/components/accordion.tsx',
    rows: [
      {
        title: '默认展开',
        hint: 'defaultValue 是数组，可以同时展开多项。首屏至少展开一项，否则用户不知道里面有东西。',
        items: [
          preview({ open: '第一项' }, "['a']"),
          preview({ open: '全部' }, "['a','b']"),
          preview({ open: '都收起' }, '[]'),
          preview({ open: '第一项', disabled: true }, 'disabled'),
        ],
      },
    ],
    knobs: {
      open: { kind: 'select', label: '默认展开', options: ['第一项', '全部', '都收起'], default: '第一项' },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    render: (v) => {
      const mode = s(v, 'open')
      const value = mode === '全部' ? ['a', 'b'] : mode === '第一项' ? ['a'] : []
      return (
        <Accordion defaultValue={value} disabled={b(v, 'disabled')} className="w-80">
          <AccordionItem value="a">
            <AccordionTrigger>角色决定什么</AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              能进哪些菜单、能点哪些按钮。
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>数据范围决定什么</AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              同一个页面里，他能看到哪些行。
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )
    },
    code: (v) => {
      const mode = s(v, 'open')
      const value = mode === '全部' ? "{['a', 'b']}" : mode === '第一项' ? "{['a']}" : '{[]}'
      return jsx(
        'Accordion',
        { defaultValue: `DV${value}`, disabled: b(v, 'disabled') },
        lines(
          '<AccordionItem value="a">',
          '  <AccordionTrigger>角色决定什么</AccordionTrigger>',
          '  <AccordionContent>说明文案</AccordionContent>',
          '</AccordionItem>'
        )
      ).replace(`defaultValue="DV${value}"`, `defaultValue=${value}`)
    },
  },

  {
    id: 'avatar',
    name: 'Avatar',
    zh: '头像',
    group: 'data',
    summary: '有图用 AvatarImage，没图落回 AvatarFallback（取名字首字）。多人用 AvatarGroup 叠。',
    source: 'packages/ui/src/components/avatar.tsx',
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
    group: 'data',
    summary:
      '一块有边界的内容。列表页不要用它包表格 —— DataTable 自己就有容器；卡片是给指标、说明这类东西的。',
    source: 'packages/ui/src/components/card.tsx',
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
]
