import { IconCopy, IconDots, IconTrash } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@admin/ui/components/context-menu'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@admin/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@admin/ui/components/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@admin/ui/components/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@admin/ui/components/tooltip'

import { b, jsx, lines, preview, s, type Demo } from '../kit'

const SIDES = ['top', 'right', 'bottom', 'left'] as const
const ALIGNS = ['start', 'center', 'end'] as const

export const OVERLAY_DEMOS: Demo[] = [
  {
    id: 'context-menu',
    name: 'ContextMenu',
    zh: '右键菜单',
    group: 'overlay',
    summary:
      '右键（或长按）唤出的动作菜单。和 DropdownMenu 是同一套 Base UI 底座、同一套子组件形状，' +
      '区别只在触发方式 —— 所以 ContextMenuLabel 同样必须包在 ContextMenuGroup 里，' +
      '不然 Base UI 抛 MenuGroupContext is missing。',
    source: 'packages/ui/src/components/context-menu.tsx',
    use: '表格行、标签条、画布元素上的**次要**动作 —— 右键是给熟手用的加速通道。',
    avoid: '不要把只在右键里出现的动作做成唯一入口 —— 触屏和不知道能右键的人永远找不到。DataGrid 的行菜单同时有一个「⋯」按钮。',
    knobs: {
      shortcut: { kind: 'bool', label: '显示快捷键', default: true },
      danger: { kind: 'bool', label: '含危险动作', default: true, hint: 'variant="destructive"' },
      label: { kind: 'text', label: '分组标题', default: '行操作' },
    },
    render: (v) => (
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div className="flex h-24 w-72 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-sm text-muted-foreground select-none" />
          }
        >
          在这块区域上点右键
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            {s(v, 'label') && <ContextMenuLabel>{s(v, 'label')}</ContextMenuLabel>}
            <ContextMenuItem>
              查看详情
              {b(v, 'shortcut') && <ContextMenuShortcut>⏎</ContextMenuShortcut>}
            </ContextMenuItem>
            <ContextMenuItem>
              复制 ID
              {b(v, 'shortcut') && <ContextMenuShortcut>⌘C</ContextMenuShortcut>}
            </ContextMenuItem>
          </ContextMenuGroup>
          {b(v, 'danger') && (
            <>
              <ContextMenuSeparator />
              <ContextMenuGroup>
                <ContextMenuItem variant="destructive">
                  删除
                  {b(v, 'shortcut') && <ContextMenuShortcut>⌫</ContextMenuShortcut>}
                </ContextMenuItem>
              </ContextMenuGroup>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    ),
    code: (v) =>
      jsx(
        'ContextMenu',
        {},
        lines(
          '<ContextMenuTrigger render={<TableRow />}>…</ContextMenuTrigger>',
          '<ContextMenuContent>',
          '  {/* 🔴 Label 必须包在 Group 里，否则 Base UI 抛 MenuGroupContext is missing */}',
          '  <ContextMenuGroup>',
          s(v, 'label') ? `    <ContextMenuLabel>${s(v, 'label')}</ContextMenuLabel>` : '',
          '    <ContextMenuItem onClick={() => open(row)}>',
          '      查看详情',
          b(v, 'shortcut') ? '      <ContextMenuShortcut>⏎</ContextMenuShortcut>' : '',
          '    </ContextMenuItem>',
          '  </ContextMenuGroup>',
          b(v, 'danger') ? '  <ContextMenuSeparator />' : '',
          b(v, 'danger') ? '  <ContextMenuGroup>' : '',
          b(v, 'danger') ? '    <ContextMenuItem variant="destructive">删除</ContextMenuItem>' : '',
          b(v, 'danger') ? '  </ContextMenuGroup>' : '',
          '</ContextMenuContent>'
        )
      ),
  },

  {
    id: 'dialog',
    name: 'Dialog',
    zh: '对话框',
    group: 'overlay',
    summary:
      '打断式确认。业务里的二次确认不要手搭这个 —— 用 platform/shell/confirm-dialog（支持 async + pending）。',
    source: 'packages/ui/src/components/dialog.tsx',
    use: '需要用户当场决断、且内容不多的：二次确认、简短表单。',
    avoid: '字段多的表单用 Sheet（抽屉能给更多纵向空间）；二次确认直接用 platform/shell/confirm-dialog。',
    rows: [
      {
        title: '用法',
        hint: '危险动作把主按钮换成 destructive，并在描述里写清后果 —— 「此操作不可撤销」要具体到影响了谁。',
        items: [
          preview({ destructive: false, description: true }, '普通'),
          preview({ destructive: true, description: true }, '危险'),
          preview({ destructive: false, description: false }, '无描述'),
          preview({ destructive: false, description: true, showCloseButton: false }, '无右上角关闭'),
        ],
      },
    ],
    knobs: {
      showCloseButton: { kind: 'bool', label: 'showCloseButton', default: true },
      destructive: { kind: 'bool', label: '危险操作', default: false, hint: '主按钮换成 destructive' },
      description: { kind: 'bool', label: '带描述', default: true },
    },
    render: (v) => (
      <Dialog>
        <DialogTrigger render={<Button variant="outline" />}>打开对话框</DialogTrigger>
        <DialogContent showCloseButton={b(v, 'showCloseButton')}>
          <DialogHeader>
            <DialogTitle>{b(v, 'destructive') ? '删除 3 个角色？' : '重命名角色'}</DialogTitle>
            {b(v, 'description') && (
              <DialogDescription>
                {b(v, 'destructive')
                  ? '被删角色下的成员会立刻失去对应菜单和数据范围，此操作不可撤销。'
                  : '角色名只用于展示，权限码不受影响。'}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
            <Button variant={b(v, 'destructive') ? 'destructive' : 'default'}>
              {b(v, 'destructive') ? '删除' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
    code: (v) =>
      jsx(
        'Dialog',
        {},
        lines(
          '<DialogTrigger render={<Button variant="outline" />}>打开对话框</DialogTrigger>',
          jsx(
            'DialogContent',
            { showCloseButton: b(v, 'showCloseButton') ? undefined : false },
            lines(
              '<DialogHeader>',
              '  <DialogTitle>重命名角色</DialogTitle>',
              b(v, 'description') && '  <DialogDescription>说明文案</DialogDescription>',
              '</DialogHeader>',
              '<DialogFooter>',
              '  <DialogClose render={<Button variant="outline" />}>取消</DialogClose>',
              `  <Button${b(v, 'destructive') ? ' variant="destructive"' : ''}>保存</Button>`,
              '</DialogFooter>'
            )
          )
        )
      ).replace('showCloseButton="false"', 'showCloseButton={false}'),
  },

  {
    id: 'sheet',
    name: 'Sheet',
    zh: '侧滑面板',
    group: 'overlay',
    summary:
      '表单类的编辑面板走它。改宽度必须带同样的变体前缀：data-[side=right]:sm:max-w-2xl，纯 sm:max-w-2xl 会失效。',
    source: 'packages/ui/src/components/sheet.tsx',
    use: '侧滑抽屉：新增 / 编辑表单、详情。宽度覆盖必须带 data-[side=right]: 前缀。',
    avoid: '只有一两个字段、或只是确认一下的用 Dialog。',
    rows: [
      {
        title: '方向',
        hint: 'right 是表单编辑的默认位置；bottom 给移动端；top 基本只用来放全局提示条。',
        items: [
          preview({ side: 'right' }, 'right'),
          preview({ side: 'left' }, 'left'),
          preview({ side: 'top' }, 'top'),
          preview({ side: 'bottom' }, 'bottom'),
          preview({ side: 'right', wide: true }, 'right + 加宽'),
        ],
      },
    ],
    knobs: {
      side: { kind: 'select', label: 'side', options: SIDES, default: 'right' },
      wide: { kind: 'bool', label: '加宽', default: false, hint: '演示带变体前缀的覆盖写法' },
    },
    render: (v) => {
      const side = s(v, 'side') as 'right'
      return (
        <Sheet>
          <SheetTrigger render={<Button variant="outline" />}>打开面板</SheetTrigger>
          <SheetContent
            side={side}
            className={b(v, 'wide') ? 'data-[side=right]:sm:max-w-2xl data-[side=left]:sm:max-w-2xl' : undefined}
          >
            <SheetHeader>
              <SheetTitle>编辑用户</SheetTitle>
              <SheetDescription>改完点保存，未保存的改动切走会丢。</SheetDescription>
            </SheetHeader>
            <div className="px-4 text-sm text-muted-foreground">这里放表单。</div>
          </SheetContent>
        </Sheet>
      )
    },
    code: (v) =>
      jsx(
        'Sheet',
        {},
        lines(
          '<SheetTrigger render={<Button variant="outline" />}>打开面板</SheetTrigger>',
          jsx(
            'SheetContent',
            {
              side: s(v, 'side') === 'right' ? undefined : s(v, 'side'),
              className: b(v, 'wide') ? 'data-[side=right]:sm:max-w-2xl' : undefined,
            },
            lines(
              '<SheetHeader>',
              '  <SheetTitle>编辑用户</SheetTitle>',
              '  <SheetDescription>说明文案</SheetDescription>',
              '</SheetHeader>'
            )
          )
        )
      ),
  },

  {
    id: 'popover',
    name: 'Popover',
    zh: '浮层',
    group: 'overlay',
    summary: '非打断式的补充信息或小表单。side / align 决定它从哪边冒出来。',
    source: 'packages/ui/src/components/popover.tsx',
    use: '挂在某个元素上的轻浮层：筛选面板、颜色选择、说明卡。',
    avoid: '一句话说明用 Tooltip（不需要点，也不抢焦点）；一列可点动作用 DropdownMenu。',
    rows: [
      {
        title: '方位',
        hint: 'side 是从哪一边冒出来，align 是沿那条边怎么对齐。贴边的触发器要靠 align 兜住，否则浮层会被视口挤走。',
        items: [
          preview({ side: 'bottom', align: 'start' }, 'bottom / start'),
          preview({ side: 'bottom', align: 'center' }, 'bottom / center'),
          preview({ side: 'bottom', align: 'end' }, 'bottom / end'),
          preview({ side: 'right', align: 'center' }, 'right'),
          preview({ side: 'top', align: 'center' }, 'top'),
        ],
      },
    ],
    knobs: {
      side: { kind: 'select', label: 'side', options: SIDES, default: 'bottom' },
      align: { kind: 'select', label: 'align', options: ALIGNS, default: 'center' },
    },
    render: (v) => (
      <Popover>
        <PopoverTrigger render={<Button variant="outline" />}>数据范围说明</PopoverTrigger>
        <PopoverContent side={s(v, 'side') as 'bottom'} align={s(v, 'align') as 'center'} className="w-64">
          <PopoverHeader>
            <PopoverTitle>数据范围</PopoverTitle>
            <PopoverDescription>决定这个角色能看到哪些行，和菜单权限是两件事。</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    ),
    code: (v) =>
      jsx(
        'Popover',
        {},
        lines(
          '<PopoverTrigger render={<Button variant="outline" />}>数据范围说明</PopoverTrigger>',
          jsx(
            'PopoverContent',
            {
              side: s(v, 'side') === 'bottom' ? undefined : s(v, 'side'),
              align: s(v, 'align') === 'center' ? undefined : s(v, 'align'),
            },
            lines(
              '<PopoverHeader>',
              '  <PopoverTitle>数据范围</PopoverTitle>',
              '  <PopoverDescription>说明文案</PopoverDescription>',
              '</PopoverHeader>'
            )
          )
        )
      ),
  },

  {
    id: 'tooltip',
    name: 'Tooltip',
    zh: '提示',
    group: 'overlay',
    summary:
      '只放「看一眼就够」的短说明。必须包一层 TooltipProvider —— 应用里没有全局挂。图标按钮一律配它 + aria-label。',
    source: 'packages/ui/src/components/tooltip.tsx',
    use: '给图标按钮补一句话。图标按钮一律要配，否则读屏只念出一个空按钮。',
    avoid: '锚点不能是 display:contents 的包装元素 —— 气泡会飞到视口左上角。直接 render={trigger}。',
    rows: [
      {
        title: '方位',
        hint: '图标按钮一律配 tooltip + aria-label：tooltip 给看得见的人，aria-label 给读屏 —— 少一个都不行。',
        items: [
          preview({ side: 'top', text: '移除' }, 'top'),
          preview({ side: 'right', text: '复制权限码' }, 'right'),
          preview({ side: 'bottom', text: '导出当前筛选' }, 'bottom'),
          preview({ side: 'left', text: '刷新' }, 'left'),
        ],
      },
    ],
    knobs: {
      side: { kind: 'select', label: 'side', options: SIDES, default: 'top' },
      text: { kind: 'text', label: '提示文案', default: '从本范围移除' },
    },
    render: (v) => (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon" aria-label={s(v, 'text')} />}
          >
            <IconTrash />
          </TooltipTrigger>
          <TooltipContent side={s(v, 'side') as 'top'}>{s(v, 'text')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
    code: (v) =>
      jsx(
        'TooltipProvider',
        {},
        jsx(
          'Tooltip',
          {},
          lines(
            `<TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="${s(v, 'text')}" />}>`,
            '  <IconTrash />',
            '</TooltipTrigger>',
            jsx(
              'TooltipContent',
              { side: s(v, 'side') === 'top' ? undefined : s(v, 'side') },
              s(v, 'text')
            )
          )
        )
      ),
  },

  {
    id: 'dropdown-menu',
    name: 'DropdownMenu',
    zh: '下拉菜单',
    group: 'overlay',
    summary:
      '行操作、批量操作的入口。DropdownMenuLabel 必须包在 DropdownMenuGroup 里，否则 Base UI 会抛 MenuGroupContext is missing。',
    source: 'packages/ui/src/components/dropdown-menu.tsx',
    use: '一列可点动作：行操作、用户菜单。DropdownMenuLabel 必须包在 DropdownMenuGroup 里。',
    avoid: '选一个值出来（而不是执行动作）用 Select / Combobox —— 菜单不维护「当前选中」。',
    rows: [
      {
        title: '方位与分组',
        hint: '表格行操作用 side="bottom" align="end"（贴住右侧操作列）；分组标题必须在 Group 里。',
        items: [
          preview({ side: 'bottom', align: 'start', label: true }, 'bottom / start'),
          preview({ side: 'bottom', align: 'end', label: true }, 'bottom / end'),
          preview({ side: 'right', align: 'start', label: true }, 'right'),
          preview({ side: 'bottom', align: 'start', label: false }, '无分组标题'),
        ],
      },
    ],
    knobs: {
      side: { kind: 'select', label: 'side', options: SIDES, default: 'bottom' },
      align: { kind: 'select', label: 'align', options: ALIGNS, default: 'start' },
      label: { kind: 'bool', label: '带分组标题', default: true },
    },
    render: (v) => (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="行操作" />}>
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent side={s(v, 'side') as 'bottom'} align={s(v, 'align') as 'start'}>
          <DropdownMenuGroup>
            {b(v, 'label') && <DropdownMenuLabel>操作</DropdownMenuLabel>}
            <DropdownMenuItem>
              <IconCopy />
              复制权限码
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <IconTrash />
              删除
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
    code: (v) =>
      jsx(
        'DropdownMenu',
        {},
        lines(
          '<DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="行操作" />}>',
          '  <IconDots />',
          '</DropdownMenuTrigger>',
          jsx(
            'DropdownMenuContent',
            {
              side: s(v, 'side') === 'bottom' ? undefined : s(v, 'side'),
              align: s(v, 'align') === 'start' ? undefined : s(v, 'align'),
            },
            jsx(
              'DropdownMenuGroup',
              {},
              lines(
                b(v, 'label') && '<DropdownMenuLabel>操作</DropdownMenuLabel>',
                '<DropdownMenuItem><IconCopy />复制权限码</DropdownMenuItem>',
                '<DropdownMenuSeparator />',
                '<DropdownMenuItem variant="destructive"><IconTrash />删除</DropdownMenuItem>'
              )
            )
          )
        )
      ),
  },
]
