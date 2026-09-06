import * as React from 'react'
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowRight,
  IconBold,
  IconCheck,
  IconDownload,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Calendar } from '@admin/ui/components/calendar'
import { Checkbox } from '@admin/ui/components/checkbox'
import { Combobox } from '@admin/ui/components/combobox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@admin/ui/components/field'
import { Input } from '@admin/ui/components/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@admin/ui/components/input-group'
import { Label } from '@admin/ui/components/label'
import { RadioGroup, RadioGroupItem } from '@admin/ui/components/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@admin/ui/components/select'
import { Switch } from '@admin/ui/components/switch'
import { Textarea } from '@admin/ui/components/textarea'
import { Toggle } from '@admin/ui/components/toggle'
import { ToggleGroup, ToggleGroupItem } from '@admin/ui/components/toggle-group'

import { b, jsx, lines, n, preview, s, type Demo } from '../kit'

/** 图标既要能渲染，也要能出现在代码里，所以组件和名字得成对存着 */
const ICONS = {
  无: null,
  新建: { Cmp: IconPlus, tag: 'IconPlus' },
  导出: { Cmp: IconDownload, tag: 'IconDownload' },
  删除: { Cmp: IconTrash, tag: 'IconTrash' },
  确认: { Cmp: IconCheck, tag: 'IconCheck' },
  跳转: { Cmp: IconArrowRight, tag: 'IconArrowRight' },
} as const

type IconName = keyof typeof ICONS

const ICON_NAMES = Object.keys(ICONS) as IconName[]
const VARIANTS = ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const
const SIZES = ['xs', 'sm', 'default', 'lg', 'icon-xs', 'icon-sm', 'icon'] as const

export const FORM_DEMOS: Demo[] = [
  {
    id: 'label',
    name: 'Label',
    zh: '标签',
    group: 'form',
    summary:
      '一层薄封装：加了 peer-disabled / group-data-[disabled] 的联动置灰，' +
      '以及 select-none（双击标签选中文字很烦）。htmlFor 指向控件的 id，点标签能聚焦控件。',
    source: 'packages/ui/src/components/label.tsx',
    use: '任何裸控件旁边的说明文字，尤其是 Checkbox / Switch —— 它们的点击热区只有 16px，标签能把热区扩到整行。',
    avoid: '抽屉表单里不要直接用它，用 _shared/form-fields 的 FormField —— 那一层带错误位和必填标记，历史上 5 个表单各写了一份包裹件、3 份字节级相同。',
    knobs: {
      text: { kind: 'text', label: '文案', default: '接收邮件通知' },
      control: { kind: 'select', label: '配哪个控件', options: ['Checkbox', 'Switch', 'Input'], default: 'Checkbox' },
      disabled: { kind: 'bool', label: 'disabled', default: false, hint: '看标签会不会跟着变灰' },
    },
    render: (v) => {
      const kind = s(v, 'control')
      const id = 'sandbox-label-demo'
      const disabled = b(v, 'disabled')
      return (
        <div className={kind === 'Input' ? 'flex flex-col gap-2' : 'flex items-center gap-2'}>
          {kind === 'Input' ? (
            <>
              <Label htmlFor={id}>{s(v, 'text')}</Label>
              <Input id={id} disabled={disabled} className="w-56" />
            </>
          ) : (
            <>
              {kind === 'Checkbox' ? (
                <Checkbox id={id} disabled={disabled} className="peer" />
              ) : (
                <Switch id={id} disabled={disabled} className="peer" />
              )}
              <Label htmlFor={id}>{s(v, 'text')}</Label>
            </>
          )}
        </div>
      )
    },
    code: (v) =>
      s(v, 'control') === 'Input'
        ? lines(
            `<Label htmlFor="notify">${s(v, 'text')}</Label>`,
            `<Input id="notify"${b(v, 'disabled') ? ' disabled' : ''} />`
          )
        : lines(
            '{/* peer 让标签跟着控件的 disabled 一起置灰 */}',
            `<${s(v, 'control')} id="notify" className="peer"${b(v, 'disabled') ? ' disabled' : ''} />`,
            `<Label htmlFor="notify">${s(v, 'text')}</Label>`
          ),
  },

  {
    id: 'field',
    name: 'Field',
    zh: '字段容器',
    group: 'form',
    summary:
      'shadcn 上游那套字段结构原语：FieldSet / FieldLegend / FieldGroup / Field / ' +
      'FieldLabel / FieldTitle / FieldDescription / FieldSeparator / FieldError。' +
      '它只管**结构和间距**，不管校验 —— 错误文案得自己塞进 FieldError。',
    source: 'packages/ui/src/components/field.tsx',
    use: '需要「标题 + 说明 + 控件」三段式的设置项，尤其是控件在右、说明在左那种横排布局。',
    avoid: '🔴 抽屉里的表单字段**不是**它 —— 用 _shared/form-fields 的 FormField。Field 是 ComponentProps<div>，没有 label / error / required 这些口子。',
    stage: 'stretch',
    knobs: {
      orientation: { kind: 'select', label: '排布', options: ['vertical', 'horizontal'], default: 'horizontal' },
      description: { kind: 'bool', label: '说明文字', default: true },
      error: { kind: 'text', label: '错误文案', default: '' },
      legend: { kind: 'bool', label: '外层分组', default: true, hint: 'FieldSet + FieldLegend，读屏会念「xxx 分组」' },
    },
    render: (v) => {
      const horizontal = s(v, 'orientation') === 'horizontal'
      const err = s(v, 'error')
      const body = (
        <FieldGroup>
          <Field orientation={horizontal ? 'horizontal' : 'vertical'}>
            <FieldContent>
              <FieldLabel htmlFor="sandbox-field-a">开启双因子认证</FieldLabel>
              {b(v, 'description') && (
                <FieldDescription>登录时除了密码，还要输入一次动态验证码。</FieldDescription>
              )}
              {err && <FieldError>{err}</FieldError>}
            </FieldContent>
            <Switch id="sandbox-field-a" aria-invalid={Boolean(err)} />
          </Field>
          <FieldSeparator />
          <Field orientation={horizontal ? 'horizontal' : 'vertical'}>
            <FieldContent>
              <FieldLabel htmlFor="sandbox-field-b">会话有效期</FieldLabel>
              {b(v, 'description') && (
                <FieldDescription>超过这个时长没有操作就要求重新登录。</FieldDescription>
              )}
            </FieldContent>
            <Input id="sandbox-field-b" defaultValue="7 天" className="w-32" />
          </Field>
        </FieldGroup>
      )
      return b(v, 'legend') ? (
        <FieldSet className="w-full">
          <FieldLegend variant="label">安全设置</FieldLegend>
          {body}
        </FieldSet>
      ) : (
        <div className="w-full">{body}</div>
      )
    },
    code: (v) =>
      lines(
        b(v, 'legend') ? '<FieldSet>' : '',
        b(v, 'legend') ? '  <FieldLegend variant="label">安全设置</FieldLegend>' : '',
        '  <FieldGroup>',
        `    <Field orientation="${s(v, 'orientation')}">`,
        '      <FieldContent>',
        '        <FieldLabel htmlFor="mfa">开启双因子认证</FieldLabel>',
        b(v, 'description')
          ? '        <FieldDescription>登录时除了密码，还要输入一次动态验证码。</FieldDescription>'
          : '',
        s(v, 'error') ? `        <FieldError>${s(v, 'error')}</FieldError>` : '',
        '      </FieldContent>',
        '      <Switch id="mfa" />',
        '    </Field>',
        '  </FieldGroup>',
        b(v, 'legend') ? '</FieldSet>' : ''
      ),
  },

  {
    id: 'toggle',
    name: 'Toggle',
    zh: '切换按钮',
    group: 'form',
    summary:
      '一个有「按下」状态的按钮（aria-pressed）。和 Switch 的区别是它长得像按钮、' +
      '通常只有一个图标，而且**成组出现时该用 ToggleGroup**。',
    source: 'packages/ui/src/components/toggle.tsx',
    use: '工具栏里的开关式命令：加粗、斜体、显示网格线。',
    avoid: '设置项里的「开 / 关」用 Switch —— Toggle 没有可读的状态文字，读屏只念得出 aria-pressed。',
    knobs: {
      variant: { kind: 'select', label: 'variant', options: ['default', 'outline'], default: 'default' },
      size: { kind: 'select', label: 'size', options: ['sm', 'default', 'lg'], default: 'default' },
      defaultPressed: { kind: 'bool', label: '默认按下', default: false },
      disabled: { kind: 'bool', label: 'disabled', default: false },
      label: { kind: 'text', label: '文案', default: '', hint: '留空就是纯图标（必须有 aria-label）' },
    },
    rows: [
      {
        title: '两种变体 × 三种尺寸',
        hint: 'outline 用在独立的一个开关上；default（无边框）用在成排的工具栏里，边框会太吵。',
        items: [
          preview({ variant: 'default', size: 'sm' }, 'default sm'),
          preview({ variant: 'default', size: 'default' }, 'default'),
          preview({ variant: 'outline', size: 'default' }, 'outline'),
          preview({ variant: 'outline', size: 'lg', defaultPressed: true }, 'lg · 按下'),
          preview({ variant: 'outline', label: '加粗' }, '带文字'),
        ],
      },
    ],
    render: (v) => (
      <Toggle
        variant={s(v, 'variant') as 'default'}
        size={s(v, 'size') as 'default'}
        defaultPressed={b(v, 'defaultPressed')}
        disabled={b(v, 'disabled')}
        aria-label="加粗"
      >
        <IconBold />
        {s(v, 'label')}
      </Toggle>
    ),
    code: (v) =>
      jsx(
        'Toggle',
        {
          variant: s(v, 'variant') === 'default' ? undefined : s(v, 'variant'),
          size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
          defaultPressed: b(v, 'defaultPressed') || undefined,
          disabled: b(v, 'disabled') || undefined,
          'aria-label': '加粗',
        },
        lines('<IconBold />', s(v, 'label') || undefined)
      ),
  },

  {
    id: 'toggle-group',
    name: 'ToggleGroup',
    zh: '切换按钮组',
    group: 'form',
    summary:
      '一排 Toggle。`spacing={0}` 会把它们粘成一条（首尾圆角、中间去掉重复边框），' +
      '这是分段控件（segmented control）的样子；`spacing={2}` 是各自独立的按钮。' +
      'toggleMultiple 决定单选还是多选。',
    source: 'packages/ui/src/components/toggle-group.tsx',
    use: '视图切换（列表 / 宫格）、对齐方式、密度 —— 选项少、要一眼看全、而且互斥。',
    avoid: '超过 4 个选项换 Select；选项之间不互斥、也不成组时用独立的 Toggle。',
    knobs: {
      spacing: { kind: 'int', label: 'spacing', default: 0, min: 0, max: 3, hint: '0 = 粘成一条（分段控件）' },
      variant: { kind: 'select', label: 'variant', options: ['default', 'outline'], default: 'outline' },
      size: { kind: 'select', label: 'size', options: ['sm', 'default', 'lg'], default: 'sm' },
      multiple: { kind: 'bool', label: '可多选', default: false, hint: 'Base UI 的 prop 叫 multiple，不是 type="multiple"' },
    },
    render: (v) => (
      <ToggleGroup
        spacing={n(v, 'spacing')}
        variant={s(v, 'variant') as 'outline'}
        size={s(v, 'size') as 'sm'}
        multiple={b(v, 'multiple')}
        defaultValue={['left']}
      >
        <ToggleGroupItem value="left" aria-label="左对齐">
          <IconAlignLeft />
        </ToggleGroupItem>
        <ToggleGroupItem value="center" aria-label="居中">
          <IconAlignCenter />
        </ToggleGroupItem>
        <ToggleGroupItem value="right" aria-label="右对齐">
          <IconAlignRight />
        </ToggleGroupItem>
      </ToggleGroup>
    ),
    code: (v) =>
      jsx(
        'ToggleGroup',
        {
          spacing: n(v, 'spacing') === 2 ? undefined : n(v, 'spacing'),
          variant: s(v, 'variant') === 'default' ? undefined : s(v, 'variant'),
          size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
          multiple: b(v, 'multiple') || undefined,
          value: '{value}',
          onValueChange: '{setValue}',
        },
        lines(
          '{/* 图标项必须有 aria-label，否则读屏只念出一个空按钮 */}',
          '<ToggleGroupItem value="left" aria-label="左对齐"><IconAlignLeft /></ToggleGroupItem>',
          '<ToggleGroupItem value="center" aria-label="居中"><IconAlignCenter /></ToggleGroupItem>'
        )
      ),
  },

  {
    id: 'calendar',
    name: 'Calendar',
    zh: '日历',
    group: 'form',
    summary:
      'react-day-picker 的皮肤层。**它是裸日历，不带输入框、不带浮层** —— ' +
      '日常选时间请用 DateTimePicker（那个把它塞进 Popover 并解决了值的格式问题）。' +
      '直接用 Calendar 的场景是「日历本身就是页面的主体」。',
    source: 'packages/ui/src/components/calendar.tsx',
    use: '排期表、值班表这种把整月摊开给人看的界面。',
    avoid: '🔴 表单和筛选栏里选时间用 DateTimePicker —— 直接用 Calendar 你得自己处理浮层、值的格式（本地时间串 vs Date）、以及区间的 00:00:00 / 23:59:59 补齐。',
    knobs: {
      mode: { kind: 'select', label: 'mode', options: ['single', 'range', 'multiple'], default: 'single' },
      captionLayout: { kind: 'select', label: '标题栏', options: ['label', 'dropdown'], default: 'label', hint: 'dropdown 能直接跳年月' },
      showOutsideDays: { kind: 'bool', label: '显示上下月余日', default: true },
      numberOfMonths: { kind: 'int', label: '月份数', default: 1, min: 1, max: 2 },
    },
    render: (v) => (
      <Calendar
        mode={s(v, 'mode') as 'single'}
        captionLayout={s(v, 'captionLayout') as 'label'}
        showOutsideDays={b(v, 'showOutsideDays')}
        numberOfMonths={n(v, 'numberOfMonths')}
        className="rounded-lg border border-border"
      />
    ),
    code: (v) =>
      jsx('Calendar', {
        mode: s(v, 'mode'),
        selected: '{selected}',
        onSelect: '{setSelected}',
        captionLayout: s(v, 'captionLayout') === 'label' ? undefined : s(v, 'captionLayout'),
        showOutsideDays: b(v, 'showOutsideDays') ? undefined : '{false}',
        numberOfMonths: n(v, 'numberOfMonths') === 1 ? undefined : n(v, 'numberOfMonths'),
      }),
  },

  {
    id: 'button',
    name: 'Button',
    zh: '按钮',
    group: 'form',
    summary:
      'variant 决定语气，size 决定它站在哪一行。icon-* 尺寸是正方形的纯图标按钮 —— 那种必须配 aria-label，否则读屏只会念出一个空按钮。',
    source: 'packages/ui/src/components/button.tsx',
    use: '任何可点击的动作。一屏只该有一个 default（主操作），其余用 outline / ghost 降调。',
    avoid: '导航到另一个页面用 <Link>，不要给 Button 挂 onClick + navigate —— 那样中键新开、复制链接全都没有。',
    knobs: {
      variant: { kind: 'select', label: 'variant', options: VARIANTS, default: 'default' },
      size: { kind: 'select', label: 'size', options: SIZES, default: 'default' },
      children: { kind: 'text', label: '文案', default: '保存更改' },
      icon: { kind: 'select', label: '图标', options: ICON_NAMES, default: '无' },
      iconSide: { kind: 'select', label: '图标位置', options: ['前', '后'], default: '前' },
      loading: { kind: 'bool', label: '加载中', default: false, hint: '转圈并自动置灰' },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    rows: [
      {
        title: '变体',
        hint: 'default 是主操作，一屏只该有一个；destructive 只给不可撤销的动作。',
        items: VARIANTS.map((v) =>
          preview({ variant: v, children: v, icon: '无' })
        ),
      },
      {
        title: '尺寸',
        hint: 'lg / default / sm / xs 带文字，icon-* 是正方形纯图标。',
        items: [
          preview({ size: 'lg', children: 'Large', icon: '无' }),
          preview({ size: 'default', children: 'Default', icon: '无' }),
          preview({ size: 'sm', children: 'Small', icon: '无' }),
          preview({ size: 'xs', children: 'XSmall', icon: '无' }),
          preview({ size: 'icon', icon: '新建' }, 'icon'),
          preview({ size: 'icon-sm', icon: '确认', variant: 'outline' }, 'icon-sm'),
          preview({ size: 'icon-xs', icon: '导出', variant: 'ghost' }, 'icon-xs'),
        ],
      },
      {
        title: '图标与例行',
        hint: '真实工具栏里的常见组合：主操作实心、次操作描边、危险动作红字。',
        items: [
          preview({ children: '新建', icon: '新建', variant: 'default' }),
          preview({ children: '导出', icon: '导出', variant: 'outline' }),
          preview({ children: '删除', icon: '删除', variant: 'destructive' }),
          preview({ children: '确认', icon: '确认', variant: 'ghost' }),
          preview({ children: '下一步', icon: '跳转', iconSide: '后', variant: 'secondary' }),
        ],
      },
      {
        title: '状态',
        hint: 'disabled 会同时吃掉指针事件；加载中自动置灰，避免重复提交。',
        items: [
          preview({ children: '禁用', disabled: true }),
          preview({ children: '禁用（次要）', variant: 'secondary', disabled: true }),
          preview({ children: '禁用 + 图标', variant: 'outline', icon: '新建', disabled: true }),
          preview({ children: '提交中', loading: true }),
          preview({ children: '外链跳转', variant: 'link', icon: '跳转', iconSide: '后' }),
        ],
      },
    ],
    render: (v) => {
      const size = s(v, 'size')
      const iconOnly = size.startsWith('icon')
      const entry = ICONS[s(v, 'icon') as IconName]
      const Icon = entry?.Cmp
      const loading = b(v, 'loading')
      const text = s(v, 'children')
      return (
        <Button
          variant={s(v, 'variant') as 'default'}
          size={size as 'default'}
          disabled={b(v, 'disabled') || loading}
          // 纯图标按钮没有可读文案，aria-label 不是可选项
          aria-label={iconOnly ? text || s(v, 'icon') : undefined}
        >
          {loading && <IconLoader />}
          {!loading && Icon && s(v, 'iconSide') === '前' && <Icon />}
          {!iconOnly && text}
          {!loading && Icon && s(v, 'iconSide') === '后' && <Icon />}
        </Button>
      )
    },
    code: (v) => {
      const size = s(v, 'size')
      const iconOnly = size.startsWith('icon')
      const entry = ICONS[s(v, 'icon') as IconName]
      const tag = entry ? `<${entry.tag} />` : ''
      const loading = b(v, 'loading')
      const text = s(v, 'children')
      const after = !loading && tag && s(v, 'iconSide') === '后'
      return jsx(
        'Button',
        {
          variant: s(v, 'variant') === 'default' ? undefined : s(v, 'variant'),
          size: size === 'default' ? undefined : size,
          disabled: b(v, 'disabled') || loading,
          'aria-label': iconOnly ? text || s(v, 'icon') : undefined,
        },
        lines(
          loading && '<IconLoader2 className="size-4 animate-spin" />',
          !loading && tag && s(v, 'iconSide') === '前' && tag,
          !iconOnly && text,
          after && tag
        )
      )
    },
  },

  {
    id: 'input',
    name: 'Input',
    zh: '输入框',
    group: 'form',
    summary:
      '裸输入框。要放图标用 InputGroup，不要「相对定位 + 手动 padding」—— Tailwind 的 px-* 是 padding-inline 简写，会把 pl-* 覆盖掉。',
    source: 'packages/ui/src/components/input.tsx',
    use: '单行文本、数字、密码。表单里裹一层 _shared/form-fields 的 FormField 拿到标签与错误位。',
    avoid: '要带前后缀图标或单位就换 InputGroup —— 相对定位 + 手动 padding 会被 px-* 覆盖掉。',
    knobs: {
      placeholder: { kind: 'text', label: 'placeholder', default: '请输入用户名' },
      value: { kind: 'text', label: '值', default: '' },
      type: {
        kind: 'select',
        label: 'type',
        options: ['text', 'password', 'number', 'email', 'date'],
        default: 'text',
      },
      invalid: { kind: 'bool', label: 'aria-invalid', default: false, hint: '校验失败：红框 + 红环' },
      readOnly: { kind: 'bool', label: 'readOnly', default: false },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    rows: [
      {
        title: '状态',
        hint: '空态 / 有值 / 校验失败 / 只读 / 禁用。只读和禁用是两回事：只读能选中复制，禁用不能。',
        items: [
          preview({ value: '' }, '空'),
          preview({ value: 'admin' }, '有值'),
          preview({ value: 'ad', invalid: true }, 'aria-invalid'),
          preview({ value: 'admin', readOnly: true }, 'readOnly'),
          preview({ value: 'admin', disabled: true }, 'disabled'),
        ],
      },
      {
        title: '类型',
        hint: 'type 只影响输入法与原生控件，校验仍然要自己做。',
        items: [
          preview({ type: 'text', value: 'admin' }, 'text'),
          preview({ type: 'password', value: '123456' }, 'password'),
          preview({ type: 'number', value: '18' }, 'number'),
          preview({ type: 'date', value: '' }, 'date'),
        ],
      },
    ],
    render: (v) => (
      <Input
        className="w-56"
        type={s(v, 'type')}
        placeholder={s(v, 'placeholder')}
        defaultValue={s(v, 'value')}
        // key 让改「值」旋钮时重建，否则 defaultValue 不会回灌
        key={s(v, 'value')}
        aria-invalid={b(v, 'invalid') || undefined}
        readOnly={b(v, 'readOnly')}
        disabled={b(v, 'disabled')}
        aria-label="示例输入框"
      />
    ),
    code: (v) =>
      jsx('Input', {
        type: s(v, 'type') === 'text' ? undefined : s(v, 'type'),
        placeholder: s(v, 'placeholder'),
        'aria-invalid': b(v, 'invalid'),
        readOnly: b(v, 'readOnly'),
        disabled: b(v, 'disabled'),
      }),
  },

  {
    id: 'input-group',
    name: 'InputGroup',
    zh: '带附件的输入框',
    group: 'form',
    summary: '图标、单位、按钮都挂在 InputGroupAddon 上，align 决定挂前面还是后面。',
    source: 'packages/ui/src/components/input-group.tsx',
    use: '输入框需要前后缀：搜索图标、单位、清除按钮、内联小按钮。',
    avoid: '前后缀是一个独立可聚焦的控件（比如国家区号下拉）时别硬塞，两个控件并排更好用。',
    knobs: {
      start: { kind: 'bool', label: '前置图标', default: true },
      end: { kind: 'select', label: '后置内容', options: ['无', '单位', '按钮'], default: '无' },
      placeholder: { kind: 'text', label: 'placeholder', default: '搜索' },
      height: { kind: 'select', label: '高度', options: ['h-8', 'h-9', 'h-11'], default: 'h-9' },
    },
    rows: [
      {
        title: '组合',
        hint: '工具栏用 h-8（和 Button size="sm" 齐平），表单用 h-9 或 h-11。',
        items: [
          preview({ start: true, end: '无' }, '图标'),
          preview({ start: true, end: '单位', placeholder: '10' }, '图标 + 单位'),
          preview({ start: false, end: '按钮', placeholder: 'admin' }, '尾部按钮'),
          preview({ start: true, end: '无', height: 'h-8' }, 'h-8 工具栏'),
        ],
      },
    ],
    render: (v) => (
      <InputGroup className={`w-56 ${s(v, 'height')}`}>
        {b(v, 'start') && (
          <InputGroupAddon align="inline-start">
            <IconSearch />
          </InputGroupAddon>
        )}
        <InputGroupInput placeholder={s(v, 'placeholder')} aria-label="示例输入框" />
        {s(v, 'end') === '单位' && (
          <InputGroupAddon align="inline-end">
            <InputGroupText>条</InputGroupText>
          </InputGroupAddon>
        )}
        {s(v, 'end') === '按钮' && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton>清空</InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    ),
    code: (v) =>
      jsx(
        'InputGroup',
        { className: s(v, 'height') === 'h-9' ? undefined : s(v, 'height') },
        lines(
          b(v, 'start') &&
            '<InputGroupAddon align="inline-start">\n  <IconSearch />\n</InputGroupAddon>',
          jsx('InputGroupInput', { placeholder: s(v, 'placeholder') }),
          s(v, 'end') === '单位' &&
            '<InputGroupAddon align="inline-end">\n  <InputGroupText>条</InputGroupText>\n</InputGroupAddon>',
          s(v, 'end') === '按钮' &&
            '<InputGroupAddon align="inline-end">\n  <InputGroupButton>清空</InputGroupButton>\n</InputGroupAddon>'
        )
      ),
  },

  {
    id: 'textarea',
    name: 'Textarea',
    zh: '多行输入',
    group: 'form',
    summary: 'rows 给初始高度，不限制内容长度。',
    source: 'packages/ui/src/components/textarea.tsx',
    use: '多行纯文本：备注、描述、SQL 片段。',
    avoid: '要加粗 / 插图 / 列表就用 RichText —— 富文本存 HTML，Textarea 存纯文本，两者不能中途换。',
    knobs: {
      rows: { kind: 'int', label: 'rows', default: 3, min: 2, max: 10 },
      placeholder: { kind: 'text', label: 'placeholder', default: '备注（选填）' },
      invalid: { kind: 'bool', label: 'aria-invalid', default: false },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    rows: [
      {
        title: '高度与状态',
        hint: 'rows 只是起始高度；要跟着内容长就得另外做自增高。',
        items: [
          preview({ rows: 2 }, 'rows=2'),
          preview({ rows: 4 }, 'rows=4'),
          preview({ rows: 3, invalid: true }, 'aria-invalid'),
          preview({ rows: 3, disabled: true }, 'disabled'),
        ],
      },
    ],
    render: (v) => (
      <Textarea
        className="w-56"
        rows={n(v, 'rows')}
        placeholder={s(v, 'placeholder')}
        aria-invalid={b(v, 'invalid') || undefined}
        disabled={b(v, 'disabled')}
        aria-label="示例多行输入"
      />
    ),
    code: (v) =>
      jsx('Textarea', {
        rows: n(v, 'rows'),
        placeholder: s(v, 'placeholder'),
        'aria-invalid': b(v, 'invalid'),
        disabled: b(v, 'disabled'),
      }),
  },

  {
    id: 'checkbox',
    name: 'Checkbox',
    zh: '复选框',
    group: 'form',
    summary:
      '半选是**独立的 indeterminate prop**，不是 checked="indeterminate"。禁用态是 data-disabled，`:not([disabled])` 选不掉它。',
    source: 'packages/ui/src/components/checkbox.tsx',
    use: '互相独立的多选，以及表格首列的行选中（半选态走独立的 indeterminate prop）。',
    avoid: '只有开 / 关两态、且改完立刻生效的用 Switch —— Checkbox 暗示「要点保存」。',
    knobs: {
      state: {
        kind: 'select',
        label: '状态',
        options: ['unchecked', 'checked', 'indeterminate'],
        default: 'checked',
      },
      disabled: { kind: 'bool', label: 'disabled', default: false },
      label: { kind: 'text', label: '标签', default: '同意服务条款' },
    },
    rows: [
      {
        title: '三态',
        hint: '半选用在树形表格的父节点上：子节点只勾了一部分。',
        items: [
          preview({ state: 'unchecked', label: '未选' }),
          preview({ state: 'checked', label: '已选' }),
          preview({ state: 'indeterminate', label: '半选' }),
          preview({ state: 'checked', label: '禁用', disabled: true }),
        ],
      },
    ],
    render: (v) => (
      <Label className="font-normal">
        <Checkbox
          checked={s(v, 'state') === 'checked'}
          indeterminate={s(v, 'state') === 'indeterminate'}
          disabled={b(v, 'disabled')}
        />
        {s(v, 'label')}
      </Label>
    ),
    code: (v) =>
      jsx('Checkbox', {
        checked: s(v, 'state') === 'checked',
        indeterminate: s(v, 'state') === 'indeterminate' || undefined,
        disabled: b(v, 'disabled'),
      }),
  },

  {
    id: 'switch',
    name: 'Switch',
    zh: '开关',
    group: 'form',
    summary: '立即生效的二元开关。需要「改完再一起保存」的场景用 Checkbox。',
    source: 'packages/ui/src/components/switch.tsx',
    use: '立即生效的开关：偏好设置、启用/停用。',
    avoid: '需要点「保存」才生效的表单字段用 Checkbox —— Switch 会让人以为已经生效了。',
    knobs: {
      size: { kind: 'select', label: 'size', options: ['sm', 'default'], default: 'default' },
      checked: { kind: 'bool', label: 'checked', default: true },
      disabled: { kind: 'bool', label: 'disabled', default: false },
      label: { kind: 'text', label: '标签', default: '启用图形验证码' },
    },
    rows: [
      {
        title: '尺寸与状态',
        hint: 'sm 给行内（表格单元格里），default 给表单。',
        items: [
          preview({ size: 'default', checked: true, label: '开' }),
          preview({ size: 'default', checked: false, label: '关' }),
          preview({ size: 'sm', checked: true, label: 'sm 开' }),
          preview({ size: 'default', checked: true, disabled: true, label: '禁用' }),
        ],
      },
    ],
    render: (v) => (
      <Label className="font-normal">
        <Switch
          size={s(v, 'size') as 'default'}
          checked={b(v, 'checked')}
          disabled={b(v, 'disabled')}
        />
        {s(v, 'label')}
      </Label>
    ),
    code: (v) =>
      jsx('Switch', {
        size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
        checked: b(v, 'checked'),
        disabled: b(v, 'disabled'),
      }),
  },

  {
    id: 'radio-group',
    name: 'RadioGroup',
    zh: '单选组',
    group: 'form',
    summary: '选项少、且要一眼看全所有取值时用它；超过五六项换 Select。',
    source: 'packages/ui/src/components/radio-group.tsx',
    use: '2–5 个互斥选项，且需要一眼看全（配送方式、图表口径）。',
    avoid: '超过 5 项换 Select，否则一整屏都是单选钮。',
    knobs: {
      value: { kind: 'select', label: '选中', options: ['self', 'dept', 'all'], default: 'dept' },
      inline: { kind: 'bool', label: '横排', default: false },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    rows: [
      {
        title: '排布',
        hint: '选项文案短就横排省高度，长了必须竖排 —— 横排换行后对不齐。',
        items: [preview({ inline: false }, '竖排'), preview({ inline: true }, '横排')],
      },
    ],
    render: (v) => (
      <RadioGroup
        value={s(v, 'value')}
        disabled={b(v, 'disabled')}
        className={b(v, 'inline') ? 'flex w-auto gap-5' : 'w-40'}
      >
        {[
          ['self', '仅本人'],
          ['dept', '本部门'],
          ['all', '全部'],
        ].map(([val, label]) => (
          <Label key={val} className="font-normal">
            <RadioGroupItem value={val} />
            {label}
          </Label>
        ))}
      </RadioGroup>
    ),
    code: (v) =>
      jsx(
        'RadioGroup',
        {
          value: s(v, 'value'),
          disabled: b(v, 'disabled'),
          className: b(v, 'inline') ? 'flex gap-5' : undefined,
        },
        lines(
          '<Label><RadioGroupItem value="self" />仅本人</Label>',
          '<Label><RadioGroupItem value="dept" />本部门</Label>',
          '<Label><RadioGroupItem value="all" />全部</Label>'
        )
      ),
  },

  {
    id: 'combobox',
    name: 'Combobox',
    zh: '可搜索下拉',
    group: 'form',
    summary:
      '和 Select 的分工是**选项数量**：≤ 8 项用 Select（点开一眼看全），长列表用它（必须能打字）。过滤走 Intl.Collator，中文和大小写都对。',
    source: 'packages/ui/src/components/combobox.tsx',
    use: '长列表单选，带过滤（菜单的「上级菜单」28 项、「路由地址」23 项）。过滤走 Intl.Collator，中英文大小写都对。',
    avoid: '≤ 8 项用 Select —— 给三个选项配一个搜索框是噪音。',
    knobs: {
      size: { kind: 'select', label: 'size', options: ['sm', 'default'], default: 'default' },
      hint: { kind: 'bool', label: '右侧补充说明', default: true, hint: '放权限码、路由地址这类' },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    rows: [
      {
        title: '什么时候用它',
        hint: '菜单管理的「上级菜单」有 28 个选项、「路由地址」有 23 个 —— 那种规模的 Select 只能瞎滚。',
        items: [
          preview({ size: 'default', hint: true }, '带补充说明'),
          preview({ size: 'default', hint: false }, '只有标签'),
          preview({ size: 'sm', hint: false }, 'sm（工具栏）'),
          preview({ size: 'default', hint: true, disabled: true }, 'disabled'),
        ],
      },
    ],
    render: (v) => <ComboboxDemo v={v} />,
    code: (v) =>
      jsx('Combobox', {
        value: 'VALUE',
        onValueChange: 'HANDLER',
        options: 'OPTIONS',
        size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
        searchPlaceholder: '搜索路由',
        emptyText: '没有匹配的路由',
        disabled: b(v, 'disabled'),
      })
        .replace('value="VALUE"', 'value={path}')
        .replace('onValueChange="HANDLER"', 'onValueChange={setPath}')
        .replace('options="OPTIONS"', 'options={pathOptions}'),
  },

  {
    id: 'select',
    name: 'Select',
    zh: '下拉选择',
    group: 'form',
    summary:
      '必须传 items={{value: label}}，否则关闭态显示的是原始 value。改高度只能用 size —— 基础类是 data-[size=*]，属性选择器压过纯 h-8。',
    source: 'packages/ui/src/components/select.tsx',
    use: '≤ 8 项的单选：状态、类型、是否。必须传 items={{value: label}}，否则关闭态显示原始 value。',
    avoid: '选项多到要搜的用 Combobox；要选多个用 MultiSelect。',
    knobs: {
      size: { kind: 'select', label: 'size', options: ['sm', 'default'], default: 'default' },
      value: { kind: 'select', label: '选中', options: ['smtp', 'api', 'none'], default: 'smtp' },
      width: { kind: 'select', label: '宽度', options: ['w-28', 'w-40', 'w-56'], default: 'w-40' },
      disabled: { kind: 'bool', label: 'disabled', default: false },
    },
    rows: [
      {
        title: '尺寸与状态',
        hint: '工具栏里必须是 size="sm"，否则和旁边 32px 的控件差 4px，一整行参差不齐。',
        items: [
          preview({ size: 'default' }, 'default 36px'),
          preview({ size: 'sm', width: 'w-28' }, 'sm 32px'),
          preview({ size: 'default', disabled: true }, 'disabled'),
        ],
      },
    ],
    render: (v) => {
      const items = { smtp: 'SMTP 直发', api: '服务商 API', none: '不发信' }
      return (
        <Select value={s(v, 'value')} items={items} disabled={b(v, 'disabled')}>
          <SelectTrigger size={s(v, 'size') as 'default'} className={s(v, 'width')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(items).map(([val, label]) => (
              <SelectItem key={val} value={val}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    },
    code: (v) =>
      jsx(
        'Select',
        { value: s(v, 'value'), items: 'ITEMS', disabled: b(v, 'disabled') },
        lines(
          jsx('SelectTrigger', {
            size: s(v, 'size') === 'default' ? undefined : s(v, 'size'),
          }, '<SelectValue />'),
          '<SelectContent>\n  {/* 每个 key 一个 SelectItem */}\n</SelectContent>'
        )
      ).replace('items="ITEMS"', 'items={items}'),
  },
]

/** 加载中的转圈。放在文件末尾免得和上面的图标表混在一起 */
function IconLoader() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 animate-spin" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Combobox 是受控的，需要自己的 state —— demo 的 render 是纯函数，不能放 hooks */
function ComboboxDemo({ v }: { v: import('../kit').KnobValues }) {
  const [value, setValue] = React.useState<string | null>('/system/user')
  const options = React.useMemo(
    () =>
      [
        ['/dashboard', '仪表盘'],
        ['/system/user', '用户管理'],
        ['/system/role', '角色管理'],
        ['/system/menu', '菜单管理'],
        ['/system/dept', '部门管理'],
        ['/system/data-permission', '数据权限'],
        ['/log/login', '登录日志'],
        ['/log/opera', '操作日志'],
        ['/monitor/online', '在线用户'],
        ['/monitor/server', '服务器监控'],
        ['/monitor/redis', 'Redis 监控'],
        ['/sandbox/components', '组件沙箱'],
      ].map(([path, label]) => ({
        value: path as string,
        label: label as string,
        ...(b(v, 'hint') ? { hint: path as string } : {}),
      })),
    [v]
  )
  return (
    <Combobox
      value={value}
      onValueChange={setValue}
      options={options}
      size={s(v, 'size') as 'default'}
      disabled={b(v, 'disabled')}
      className="w-64"
      searchPlaceholder="搜索页面"
      emptyText="没有匹配的页面"
    />
  )
}
