import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconFilter, IconSearch, IconTrash, IconX } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput,
} from '@admin/ui/components/input-group'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'
import { Combobox } from '@admin/ui/components/combobox'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'

import { STATUS_FILTER_ITEMS, STATUS_META, TONE_CLASS } from './status'

/**
 * 列表页工具栏的公共件。
 *
 * 这三个东西原先在 9 个页面里逐字复制 —— 连「回车/失焦才提交」这条约定
 * 都是各写一遍，改一个地方就会漂移。
 *
 * 输入框刻意**不做即时提交**：每敲一个字符就 patch search 会触发一次导航 +
 * 一次请求（数据字典的类型搜索曾经就是这样）。回车或失焦提交，输入过程走本地 state。
 */
/**
 * 筛选下拉从第几项开始需要搜索框。
 * 8 是「点开一屏看得完」的上限 —— 再多就得靠打字（见组件约定表）。
 */
const SEARCHABLE_FROM = 8

/**
 * 把 `all` 提到第一位。
 *
 * `STATUS_FILTER_ITEMS` 这类常量源码里写的是 `{ all, '1', '0' }`，但
 * **JS 对象的整数样 key 永远排在字符串 key 前面**（'0' → '1' → 'all'），
 * 直接 `Object.entries` 会把「全部状态」渲染成最后一项。
 */
function orderedEntries(items: Record<string, string>): [string, string][] {
  const all = items['all']
  const rest = Object.entries(items).filter(([k]) => k !== 'all')
  return all === undefined ? rest : [['all', all], ...rest]
}

export function TextFilter({
  value,
  placeholder,
  onCommit,
  testId,
  width = 'w-52',
}: {
  value: string
  placeholder: string
  onCommit: (v: string) => void
  testId?: string
  /** 只作为**下限**用。英文比中文长约 40%，写死宽度会把文案截断
   *  （`全部状态` → `All statuses` 在 w-28 里显示成 `All statuse:`） */
  width?: string
}) {
  const { t } = useTranslation()
  const [local, setLocal] = React.useState(value)
  React.useEffect(() => setLocal(value), [value])

  return (
    // 用 InputGroup 而不是「相对定位 + 手动 padding」：Tailwind 4 的 px-* 是
    // padding-inline 简写，会盖掉 pl-* 的长写法，手动加 padding 压不过基础样式。
    <InputGroup className={`h-8 ${width}`}>
      <InputGroupAddon align="inline-start">
        <IconSearch className="size-4 text-muted-foreground" />
      </InputGroupAddon>
      <InputGroupInput
        value={local}
        data-testid={testId}
        placeholder={t(placeholder)}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onCommit(local)}
        onBlur={() => local !== value && onCommit(local)}
      />
    </InputGroup>
  )
}

/**
 * 搜索框 **+ 内嵌状态筛选**。给主从页左栏那种窄栏用。
 *
 * 为什么不并排放两个控件：左栏只有 288px 宽，`StatusFilter` 单独占一行 =
 * 用 40px 的垂直高度换一个三选一，而那 40px 本来能多显示一个角色。
 * 列表行里本来就有状态点，所以「按状态筛」是低频操作，收进搜索框尾部正合适。
 *
 * 两种态：
 * - 没筛状态 → 只显示一个漏斗图标（不占字宽，也不喊）
 * - 筛了     → 显示带色的「正常 / 停用」，**不用 tooltip** ——
 *              筛选态必须一眼看得见，否则会出现「列表怎么少了一半」的困惑
 *
 * 清除按钮同样收在尾部，只在真的有筛选时出现 —— 于是整个左栏筛选区
 * 从两行压成一行，且行数不会随筛选状态跳动（清除按钮是原地出现，不换行）。
 */
export function SearchWithStatus({
  value,
  placeholder,
  status,
  onCommit,
  onStatus,
  onReset,
  testId,
  statusTestId = 'filter-status',
  resetTestId = 'clear-filter',
}: {
  value: string
  placeholder: string
  status: number | undefined
  onCommit: (v: string) => void
  onStatus: (v: number | undefined) => void
  /** 有筛选时才给 —— 不传就不渲染清除按钮 */
  onReset?: () => void
  testId?: string
  statusTestId?: string
  resetTestId?: string
}) {
  const { t } = useTranslation()
  const [local, setLocal] = React.useState(value)
  React.useEffect(() => setLocal(value), [value])

  const meta = status === undefined ? null : STATUS_META[status]
  const hasFilter = status !== undefined || Boolean(value)

  return (
    <InputGroup className="h-8 w-full">
      <InputGroupAddon align="inline-start">
        <IconSearch className="size-4 text-muted-foreground" />
      </InputGroupAddon>
      <InputGroupInput
        value={local}
        data-testid={testId}
        placeholder={t(placeholder)}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onCommit(local)}
        onBlur={() => local !== value && onCommit(local)}
      />
      {/*
        ⚠️ 这一层的 onClick 会把焦点丢回 input，但它对 `closest('button')`
        的点击直接 return（见 ui/input-group.tsx）—— 所以尾部只能放**按钮**，
        放裸的 Select trigger 会点一下就被抢焦点。
      */}
      <InputGroupAddon align="inline-end">
        {hasFilter && onReset && (
          <InputGroupButton
            size="icon-xs"
            aria-label={t('重置')}
            data-testid={resetTestId}
            onClick={() => { setLocal(''); onReset() }}
          >
            <IconX className="size-3.5" />
          </InputGroupButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <InputGroupButton
                size={meta ? 'xs' : 'icon-xs'}
                aria-label={t('按状态筛选')}
                data-testid={statusTestId}
                className={cn(meta && ['ring-1', TONE_CLASS[meta.tone]])}
              />
            }
          >
            {meta ? t(meta.label) : <IconFilter className="size-3.5" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuRadioGroup
              value={status === undefined ? 'all' : String(status)}
              onValueChange={(v) => onStatus(v === 'all' ? undefined : Number(v))}
            >
              {/* ⚠️ 不能直接 Object.entries：JS 对象的**整数样 key**（'0'/'1'）
                  永远排在字符串 key（'all'）前面，于是「全部状态」会掉到最后一项 */}
              {orderedEntries(STATUS_FILTER_ITEMS).map(([v, label]) => (
                // closeOnClick：Base UI 的 RadioItem 默认**不关**菜单（closeOnClick = false）。
                // 不加的话选完状态菜单还开着，它的 inert 遮罩会挡住旁边的清除按钮 —— 实测点不动
                <DropdownMenuRadioItem key={v} value={v} closeOnClick>{t(label)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </InputGroupAddon>
    </InputGroup>
  )
}

/** 下拉筛选。`undefined` ↔ 'all' 的映射收在这里，各页不再各写一遍三元 */
export function SelectFilter({
  value,
  items,
  onChange,
  testId,
  width = 'min-w-28',
}: {
  value: string | number | undefined
  items: Record<string, string>
  onChange: (v: string | undefined) => void
  testId?: string
  width?: string
}) {
  const { t } = useTranslation()
  /**
   * 在**渲染处**翻译，而不是要求调用方传翻译好的 items。
   *
   * 因为 key 就是中文原文，`STATUS_FILTER_ITEMS` 这种**模块级常量**
   * （加载时求值、切语言不会更新）的值天然就是合法 key ——
   * 8 个调用点和常量本身都不用动，t() 放在这里就够了。
   * 这是「原文即 key」最实用的一个好处。
   */
  const labels = React.useMemo(
    () => Object.fromEntries(Object.entries(items).map(([v, label]) => [v, t(label)])),
    [items, t]
  )

  /**
   * 超过 SEARCHABLE_FROM 项就换成可搜索的下拉。
   *
   * 分流放在这一层而不是让调用方选：用户页的「部门」和「角色」各 32 项，
   * 塞进纯 Select 只能瞎滚（用户指出过）。而 12 个调用方里大多数是
   * 状态/启用/时间区间这类三五项的，给它们加搜索框反而是噪音。
   * 按数量自动切，调用点一个都不用改，以后长出来的长列表也自动受益。
   */
  // 同上：'all' 会被 JS 的 key 排序甩到最后，手动提前
  const entries = orderedEntries(labels)
  if (entries.length > SEARCHABLE_FROM) {
    return (
      <Combobox
        value={value === undefined ? 'all' : String(value)}
        onValueChange={(v) => onChange(v === 'all' || v == null ? undefined : String(v))}
        options={entries.map(([v, label]) => ({ value: v, label }))}
        size="sm"
        className={`w-auto ${width}`}
        data-testid={testId}
        searchPlaceholder={t('搜索')}
        emptyText={t('没有匹配项')}
      />
    )
  }

  return (
    <Select
      value={value === undefined ? 'all' : String(value)}
      items={labels}
      onValueChange={(v) => onChange(v === 'all' || v == null ? undefined : String(v))}
    >
      {/*
        ⚠️ 必须传 `size="sm"`，**不能**靠 className 里写 `h-8`。
        SelectTrigger 的基础类是 `data-[size=default]:h-9 data-[size=sm]:h-8` ——
        属性选择器 (0,2,0) 压过纯 `h-8` (0,1,0)，而 size 默认是 "default"。
        写了 h-8 也是 36px，和旁边 32px 的 InputGroup / Button size=sm 差 4px，
        工具栏一整行就会参差不齐（用户截图指出过）。
        这是同一个坑的第三次：Sheet 宽度、Select 高度、以及组件约定表里那条。
      */}
      <SelectTrigger size="sm" className={`w-auto ${width}`} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {entries.map(([v, label]) => (
          <SelectItem key={v} value={v}>{label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 「正常 / 停用」状态筛选 —— 最常见的那一种 */
export function StatusFilter({
  value,
  onChange,
  testId = 'filter-status',
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  testId?: string
}) {
  return (
    <SelectFilter
      value={value}
      items={STATUS_FILTER_ITEMS}
      testId={testId}
      onChange={(v) => onChange(v === undefined ? undefined : Number(v))}
    />
  )
}

export function ResetButton({
  onClick,
  testId = 'clear-filter',
  label,
  variant = 'ghost',
}: {
  onClick: () => void
  /** 同一页可能出现两次（工具栏 + 空态），testid 要能区分 */
  testId?: string
  label?: string
  variant?: 'ghost' | 'outline'
}) {
  const { t } = useTranslation()
  return (
    <Button variant={variant} size="sm" className="h-8" data-testid={testId} onClick={onClick}>
      <IconX className="size-4" />
      {label ?? t('重置')}
    </Button>
  )
}

/**
 * 批量操作条。选中 0 行时整块不渲染 —— 分页条上那句「已选 N 项」
 * 以前永远是 0（没有任何一列复选框），选中态是纯装饰。
 */
export function BulkBar({
  count,
  onDelete,
  pending,
  label,
  icon,
}: {
  count: number
  onDelete: () => void
  pending?: boolean
  /** 动作文案。删除是最常见的那种，但「在线用户」页是批量下线 */
  label?: string
  icon?: React.ReactNode
}) {
  const { t } = useTranslation()
  if (count === 0) return null
  return (
    <>
      <span className="text-sm text-muted-foreground" data-testid="bulk-count">
        {t('已选 {{n}} 项', { n: count })}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-destructive hover:text-destructive"
        data-testid="bulk-delete"
        disabled={pending}
        onClick={onDelete}
      >
        {icon ?? <IconTrash className="size-4" />}
        {label ?? t('批量删除')}
      </Button>
    </>
  )
}
