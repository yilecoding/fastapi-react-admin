import * as React from 'react'
import { menuTitle } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { IconChevronDown, IconGripVertical, IconLoader2, IconRotate } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Checkbox } from '@admin/ui/components/checkbox'
import { QueryError } from '@admin/ui/components/query-error'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'

import { MenuIcon } from '../../shell/icon-registry'
import type { NavNode } from '../../shell/use-sidebar'
import { SegmentedControl } from '../_shared/settings-rows'
import { QUICK_LINKS_MAX, chosenQuickLinks, moveItem, patchItem, type CardWidth, type DashboardLayout, type LayoutItem } from './layout'

/**
 * 编辑工作台：显示 / 隐藏 · 拖拽排序（键盘也能拖：Tab 到手柄 → 空格拿起 → 方向键 → 空格放下）·
 * 四档宽度 · 常用入口挑页面 · 恢复默认 · 保存 / 取消。
 *
 * 只编辑**草稿**：下面的卡片网格照着草稿实时预览，点「保存」才写服务端。
 * 排序是竖着的列表而不是在网格里直接拖卡片 —— 卡片宽度不一，网格里拖动的落点很难预测，
 * 键盘拖拽在二维网格里也不好用；竖列表的上下就是显示顺序。
 *
 * 两组（「我的工作」/「系统运行」）各一条列表、各一个 `DndContext`：系统运行区固定排在下面那一行标题之后，
 * 跨组拖过去也画不到那里 —— 干脆不让拖过组界
 */
export function DashboardEditor({
  layout,
  titleOf,
  groupOf,
  pages,
  canSave,
  saving,
  saveError,
  onChange,
  onReset,
  onCancel,
  onSave,
}: {
  layout: DashboardLayout
  titleOf: (id: string) => string
  groupOf: (id: string) => 'work' | 'system'
  pages: NavNode[]
  /**
   * 「保存」能不能点：通常是「改过了」；存的那份格式认不出来时，不改也要能存 ——
   * 提示里说的就是「编辑并保存一次就会覆盖它」，非要先改点什么才能存，坏数据就一直覆盖不掉
   */
  canSave: boolean
  saving: boolean
  saveError: unknown
  onChange: (next: DashboardLayout) => void
  onReset: () => void
  onCancel: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const widthOptions = [
    { value: 'third' as const, label: t('三分之一') },
    { value: 'half' as const, label: t('一半') },
    { value: 'two-thirds' as const, label: t('三分之二') },
    { value: 'full' as const, label: t('整行') },
  ]
  const groups = [
    { key: 'work' as const, label: t('我的工作') },
    { key: 'system' as const, label: t('系统运行') },
  ]
    .map((g) => ({ ...g, items: layout.items.filter((i) => groupOf(i.id) === g.key) }))
    .filter((g) => g.items.length > 0)

  return (
    <section
      className="flex flex-col gap-3 rounded-[14px] border border-primary/40 bg-muted/20 px-4 py-3"
      data-testid="dash-editor"
      aria-label={t('自定义工作台')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold">{t('自定义工作台')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('拖动手柄调整顺序（键盘：空格拿起、方向键移动、空格放下）。下面的卡片按这里实时预览，保存后才生效。')}
        </span>
      </div>

      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-1.5">
          {groups.length > 1 && <h3 className="text-xs font-semibold text-muted-foreground">{g.label}</h3>}
          <SortableGroup
            group={g.key}
            items={g.items}
            titleOf={titleOf}
            widthOptions={widthOptions}
            onMove={(from, to) => onChange(moveItem(layout, from, to))}
            onPatch={(id, p) => onChange(patchItem(layout, id, p))}
          />
        </div>
      ))}

      {layout.items.some((i) => i.id === 'quick-links') && (
        <QuickLinksPicker
          pages={pages}
          value={layout.quickLinks}
          onChange={(quickLinks) => onChange({ ...layout, quickLinks })}
        />
      )}

      {Boolean(saveError) && (
        <QueryError error={saveError} title={t('保存失败，布局没有改动')} testId="dash-editor-save-error" />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onReset} disabled={saving} data-testid="dash-editor-reset">
          <IconRotate className="size-4" />
          {t('恢复默认')}
        </Button>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={saving} data-testid="dash-editor-cancel">
            {t('取消')}
          </Button>
          <Button size="sm" onClick={onSave} disabled={!canSave || saving} data-testid="dash-editor-save">
            {saving && <IconLoader2 className="size-4 animate-spin" />}
            {t('保存')}
          </Button>
        </div>
      </div>
    </section>
  )
}

function SortableGroup({
  group,
  items,
  titleOf,
  widthOptions,
  onMove,
  onPatch,
}: {
  group: 'work' | 'system'
  items: LayoutItem[]
  titleOf: (id: string) => string
  widthOptions: { value: CardWidth; label: string }[]
  onMove: (fromId: string, toId: string) => void
  onPatch: (id: string, p: Partial<Pick<LayoutItem, 'visible' | 'width'>>) => void
}) {
  const { t } = useTranslation()
  const ids = items.map((i) => i.id)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // 读屏的播报：dnd-kit 默认是英文，跟着界面语言走。「第几位」是组内的位置
  const announcements = React.useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => t('已拿起「{{name}}」', { name: titleOf(String(active.id)) }),
      onDragOver: ({ active, over }) =>
        over
          ? t('「{{name}}」移到第 {{n}} 位', { name: titleOf(String(active.id)), n: ids.indexOf(String(over.id)) + 1 })
          : undefined,
      onDragEnd: ({ active, over }) =>
        over
          ? t('「{{name}}」放在第 {{n}} 位', { name: titleOf(String(active.id)), n: ids.indexOf(String(over.id)) + 1 })
          : undefined,
      onDragCancel: ({ active }) => t('已取消移动「{{name}}」', { name: titleOf(String(active.id)) }),
    }),
    [t, titleOf, ids]
  )

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    onMove(String(active.id), String(over.id))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('按空格拿起，用方向键移动，再按空格放下；按 Esc 取消。') },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-1" data-testid={`dash-editor-list-${group}`}>
          {items.map((item) => (
            <EditorRow
              key={item.id}
              id={item.id}
              title={titleOf(item.id)}
              visible={item.visible}
              width={item.width}
              widthOptions={widthOptions}
              onVisible={(visible) => onPatch(item.id, { visible })}
              onWidth={(width) => onPatch(item.id, { width })}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function EditorRow({
  id,
  title,
  visible,
  width,
  widthOptions,
  onVisible,
  onWidth,
}: {
  id: string
  title: string
  visible: boolean
  width: CardWidth
  widthOptions: { value: CardWidth; label: string }[]
  onVisible: (v: boolean) => void
  onWidth: (w: CardWidth) => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-center gap-3 rounded-md bg-background px-2 py-1.5 ring-1 ring-border/60',
        isDragging && 'z-10 shadow-md ring-primary/40',
        !visible && 'text-muted-foreground'
      )}
      data-testid={`dash-editor-row-${id}`}
      data-visible={visible}
    >
      <button
        type="button"
        className="cursor-grab rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        aria-label={t('拖动排序 {{name}}', { name: title })}
        data-testid={`dash-editor-handle-${id}`}
        {...attributes}
        {...listeners}
      >
        <IconGripVertical className="size-4" />
      </button>
      <Switch
        checked={visible}
        onCheckedChange={(v: boolean) => onVisible(Boolean(v))}
        aria-label={t('显示 {{name}}', { name: title })}
        data-testid={`dash-editor-visible-${id}`}
      />
      <span className={cn('min-w-0 flex-1 truncate text-sm', !visible && 'line-through')}>{title}</span>
      <SegmentedControl value={width} options={widthOptions} onChange={onWidth} testId={`dash-editor-width-${id}`} />
    </li>
  )
}

/**
 * 常用入口挑哪些页面。候选 = 这个人自己的侧边栏（`flattenPages`）。
 *
 * 没挑过（`null`）时勾着的是默认那几个；动一下就变成显式的清单。存着、但现在不在侧边栏里的 path
 * （权限临时收走）原样留在清单里，不在这里替他删掉，也不算进「最多 12 个」
 */
function QuickLinksPicker({
  pages,
  value,
  onChange,
}: {
  pages: NavNode[]
  value: string[] | null
  onChange: (next: string[] | null) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // 勾着的 = 存的清单里现在看得见的**全部**（不按 12 截），超了照实画、让人取消（见 `chosenQuickLinks`）
  const chosen = React.useMemo(() => new Set(chosenQuickLinks(value, pages.map((p) => p.path))), [value, pages])
  const full = chosen.size >= QUICK_LINKS_MAX
  const over = chosen.size - QUICK_LINKS_MAX

  // 在**存的整份清单**上增删，不从「看得见的」重建：暂时没权限的 path 要原样留着（顺序也不动）。
  // 新勾的排在最后 —— 快捷入口按勾选的先后显示
  function toggle(path: string, on: boolean) {
    const base = value ?? [...chosen]
    onChange(on ? (base.includes(path) ? base : [...base, path]) : base.filter((p) => p !== path))
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="dash-editor-links-toggle"
        >
          <IconChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
          {t('常用入口放哪些页面（{{n}}/{{max}}）', { n: chosen.size, max: QUICK_LINKS_MAX })}
        </Button>
        {open && value !== null && (
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onChange(null)} data-testid="dash-editor-links-default">
            {t('用默认的几个')}
          </Button>
        )}
      </div>
      {open && over > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="dash-editor-links-over">
          {t('勾了 {{n}} 个，超过上限 {{max}} 个：卡片上只显示前 {{max}} 个，请取消几个。', { n: chosen.size, max: QUICK_LINKS_MAX })}
        </p>
      )}
      {open && (
        <ul className="grid gap-1 @xl/main:grid-cols-2 @4xl/main:grid-cols-3" data-testid="dash-editor-links">
          {pages.map((p) => {
            const on = chosen.has(p.path)
            return (
              <li key={p.path}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/60 has-disabled:cursor-not-allowed has-disabled:opacity-50">
                  <Checkbox
                    checked={on}
                    disabled={!on && full}
                    onCheckedChange={(v: boolean) => toggle(p.path, Boolean(v))}
                    data-testid={`dash-editor-link-${p.path}`}
                  />
                  <MenuIcon name={p.icon} className="size-4 text-muted-foreground" />
                  <span className="truncate">{menuTitle(t, p.path, p.title)}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
