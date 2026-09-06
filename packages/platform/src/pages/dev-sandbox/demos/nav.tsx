import * as React from 'react'
import { IconChartBar, IconChevronDown, IconKey, IconUsers } from '@tabler/icons-react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@admin/ui/components/accordion'

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@admin/ui/components/breadcrumb'
import { Button } from '@admin/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@admin/ui/components/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@admin/ui/components/tabs'

import { b, jsx, lines, n, preview, s, type Demo } from '../kit'

export const NAV_DEMOS: Demo[] = [
  {
    id: 'collapsible',
    name: 'Collapsible',
    zh: '折叠块',
    group: 'nav',
    summary:
      '一块内容的展开 / 收起，没有别的。它是 Base UI 的 Collapsible 的三行封装 —— ' +
      '样式（箭头怎么转、内容怎么缩进）全留给调用方，因为这东西在侧边栏、' +
      '查询区、设置页里长得完全不一样。',
    source: 'packages/ui/src/components/collapsible.tsx',
    use: '只有一块要折叠的次要内容：高级选项、原始报文、"还有 N 项"。',
    avoid: '一组小节要互相协调（展开一个收起其他）用 Accordion —— Collapsible 之间彼此不知道对方存在。',
    knobs: {
      defaultOpen: { kind: 'bool', label: '默认展开', default: false },
      count: { kind: 'int', label: '折叠了几项', default: 3, min: 1, max: 12 },
    },
    render: (v) => (
      <Collapsible defaultOpen={b(v, 'defaultOpen')} className="w-72">
        <CollapsibleTrigger
          render={
            <Button variant="ghost" size="sm" className="w-full justify-between" />
          }
        >
          高级选项
          <IconChevronDown className="transition-transform in-data-[panel-open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
          {Array.from({ length: n(v, 'count') }).map((_, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm"
            >
              选项 {i + 1}
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    ),
    code: (v) =>
      jsx(
        'Collapsible',
        { defaultOpen: b(v, 'defaultOpen') || undefined },
        lines(
          '<CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>',
          '  高级选项',
          '  {/* 箭头跟着状态转：in-data-[panel-open] 读的是 Base UI 挂在面板上的属性 */}',
          '  <IconChevronDown className="transition-transform in-data-[panel-open]:rotate-180" />',
          '</CollapsibleTrigger>',
          '<CollapsibleContent>…</CollapsibleContent>'
        )
      ),
  },

  {
    id: 'breadcrumb',
    name: 'Breadcrumb',
    zh: '面包屑',
    group: 'nav',
    summary:
      '当前位置的层级路径，渲染成 <nav aria-label="breadcrumb"> + <ol>。' +
      '最后一项是 BreadcrumbPage（aria-current="page"，不可点），中间省略用 BreadcrumbEllipsis。',
    source: 'packages/ui/src/components/breadcrumb.tsx',
    use: '层级深、而且用户是从别处直接跳进来的页面（详情页、嵌套设置）。',
    avoid: '这套后台的主导航是侧边栏 + 多页签，扁平的一级页面加面包屑只是重复一遍页名。',
    knobs: {
      depth: { kind: 'int', label: '层级', default: 3, min: 2, max: 5 },
      ellipsis: { kind: 'bool', label: '中间省略', default: false, hint: '层级 ≥ 4 时才有意义' },
    },
    render: (v) => {
      const all = ['首页', '系统管理', '用户管理', '张伟', '登录记录']
      const items = all.slice(0, n(v, 'depth'))
      const collapse = b(v, 'ellipsis') && items.length >= 4
      const shown = collapse ? [items[0]!, '…', ...items.slice(-2)] : items
      return (
        <Breadcrumb>
          <BreadcrumbList>
            {shown.map((label, i) => {
              const last = i === shown.length - 1
              return (
                // 🔴 分隔符是 BreadcrumbItem 的**兄弟**，不是子节点 ——
                // 两个都渲染成 <li>，套起来就是 <li> 里嵌 <li>（非法 HTML，
                // React 19 会报 hydration 警告）。这个 demo 第一版就写错了，
                // 是浏览器控制台抓出来的
                <React.Fragment key={`${label}-${i}`}>
                  <BreadcrumbItem>
                    {label === '…' ? (
                      <BreadcrumbEllipsis />
                    ) : last ? (
                      <BreadcrumbPage>{label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink href="#">{label}</BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {!last && <BreadcrumbSeparator />}
                </React.Fragment>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
      )
    },
    code: (v) =>
      jsx(
        'Breadcrumb',
        {},
        jsx(
          'BreadcrumbList',
          {},
          lines(
            '<BreadcrumbItem>',
            '  {/* 路由内的跳转用 TanStack 的 Link：render={<Link to="/system/user" />} */}',
            '  <BreadcrumbLink href="/system/user">系统管理</BreadcrumbLink>',
            '</BreadcrumbItem>',
            '{/* 🔴 分隔符是 Item 的**兄弟**，不是子节点 —— 两个都是 <li> */}',
            '<BreadcrumbSeparator />',
            b(v, 'ellipsis') && n(v, 'depth') >= 4
              ? lines(
                  '<BreadcrumbItem>',
                  '  <BreadcrumbEllipsis />',
                  '</BreadcrumbItem>',
                  '<BreadcrumbSeparator />'
                )
              : '',
            '<BreadcrumbItem>',
            '  {/* 最后一项不可点，自带 aria-current="page" */}',
            '  <BreadcrumbPage>张伟</BreadcrumbPage>',
            '</BreadcrumbItem>'
          )
        )
      ),
  },

  {
    id: 'tabs',
    name: 'Tabs',
    zh: '页签',
    group: 'nav',
    summary:
      'default 是胶囊，line 是下划线。主从页的面板要配 keepMounted，否则切走再回来草稿就没了。',
    source: 'packages/ui/src/components/tabs.tsx',
    use: '同一个对象的几个面。切走要保住草稿就传 keepMounted。',
    avoid: '内容之间没有并列关系（是层级或流程）就别用 Tabs —— 那是 Accordion 或分步表单。',
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
    group: 'nav',
    summary: '长表单分段、或一屏放不下的说明。defaultValue 是数组，可以同时展开多项。',
    source: 'packages/ui/src/components/accordion.tsx',
    use: '一组可折叠的小节，默认收起、按需展开：FAQ、分组设置。',
    avoid: '只有一块要折叠用 Collapsible —— Accordion 的价值在「一组之间互斥」。',
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
]
