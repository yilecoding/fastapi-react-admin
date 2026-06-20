"use client"

import * as React from "react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  IconGripVertical,
  IconLayoutColumns,
  IconPinned,
  IconPinnedOff,
  IconRotate,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Checkbox } from "@admin/ui/components/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

/**
 * 列设置面板：显隐 + 顺序（拖拽）+ 左右固定。
 *
 * 顺序用 `columnOrderingFeature` 的 `columnOrder` state，固定用 `columnPinningFeature`。
 * 两者都要调用方在 `tableFeatures()` 里注册过 —— 没注册时对应的开关自动不渲染，
 * 而不是运行时炸掉。
 */
export function DataGridColumnSettings({
  table,
  labels = {},
}: {
  table: any
  labels?: Record<string, string>
}) {
  const all = table.getAllLeafColumns().filter((c: any) => c.getCanHide?.() !== false)
  const canOrder = typeof table.setColumnOrder === "function"
  const canPin = typeof all[0]?.pin === "function"

  const order: string[] = React.useMemo(
    () => all.map((c: any) => c.id),
    // getAllLeafColumns 每次都是新数组，用 id 串做依赖才稳
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all.map((c: any) => c.id).join()]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id || !canOrder) return
    const from = order.indexOf(String(active.id))
    const to = order.indexOf(String(over.id))
    // 拖拽只动可隐藏的那批列的相对顺序，__select__ 之类的固定列不参与
    const locked = table.getAllLeafColumns().filter((c: any) => c.getCanHide?.() === false).map((c: any) => c.id)
    table.setColumnOrder([...locked, ...arrayMove(order, from, to)])
  }

  const hiddenCount = all.filter((c: any) => !c.getIsVisible()).length

  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" size="icon" className="size-8" aria-label="列设置" />}
        data-testid="grid-column-settings"
      >
        <IconLayoutColumns className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium">列设置</span>
          <span className="text-xs text-muted-foreground">
            {all.length - hiddenCount} / {all.length} 显示
          </span>
        </div>
        <Separator />

        <div className="max-h-80 overflow-y-auto p-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              {all.map((col: any) => (
                <ColumnRow
                  key={col.id}
                  column={col}
                  label={labels[col.id] ?? String(col.columnDef?.header ?? col.id)}
                  canOrder={canOrder}
                  canPin={canPin}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <Separator />
        <div className="flex items-center justify-between p-2">
          <Button
            variant="ghost" size="sm" className="h-7 text-xs"
            data-testid="grid-columns-reset"
            onClick={() => {
              table.resetColumnVisibility?.()
              table.resetColumnOrder?.()
              table.resetColumnPinning?.()
            }}
          >
            <IconRotate className="size-3.5" />重置
          </Button>
          <Button
            variant="ghost" size="sm" className="h-7 text-xs"
            onClick={() => all.forEach((c: any) => c.toggleVisibility(true))}
          >
            全部显示
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ColumnRow({
  column, label, canOrder, canPin,
}: {
  column: any
  label: string
  canOrder: boolean
  canPin: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !canOrder,
  })
  const pinned = canPin ? column.getIsPinned?.() : false

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60",
        isDragging && "z-10 bg-muted shadow-sm"
      )}
      data-testid={`grid-column-row-${column.id}`}
    >
      {canOrder && (
        <button
          type="button"
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
          aria-label={`拖动排序 ${label}`}
          {...attributes}
          {...listeners}
        >
          <IconGripVertical className="size-3.5" />
        </button>
      )}
      <Checkbox
        checked={column.getIsVisible()}
        onCheckedChange={(v: boolean) => column.toggleVisibility(Boolean(v))}
        aria-label={label}
        data-testid={`grid-column-check-${column.id}`}
      />
      <span className="flex-1 truncate text-sm">{label}</span>
      {canPin && (
        <button
          type="button"
          className={cn("text-muted-foreground hover:text-foreground", pinned && "text-primary")}
          aria-label={pinned ? `取消固定 ${label}` : `固定 ${label} 到末尾`}
          data-testid={`grid-column-pin-${column.id}`}
          onClick={() => column.pin(pinned ? false : "end")}
        >
          {pinned ? <IconPinned className="size-3.5" /> : <IconPinnedOff className="size-3.5" />}
        </button>
      )}
    </div>
  )
}
