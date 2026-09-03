/**
 * ⚠️ **目前没有调用方，这是刻意留的**（死代码扫描会报到它，别顺手删）。
 *
 * 判据和被删掉的 `date-picker` / `date-range-picker` 不同 —— 那两个有**现成的
 * 替代品**（`datetime-picker.tsx` 的 `DateTimeValuePicker` /
 * `DateTimeRangePicker`，查询区在用），删了不丢任何东西。
 * 而这个组件在 shadcn / Base UI 生态里**没有对应物**，是手写的：
 * 月/年两级选择、跨年翻页、以及「只到月份」这种粒度的值格式。
 * 真要做月度报表筛选时从这里开始改，不要重写。
 */
"use client"

import * as React from "react"
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react"
import { Button } from "@admin/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@admin/ui/components/popover"
import { cn } from "@admin/ui/lib/utils"

interface MonthYearPickerProps {
  value?: string // format "YYYY-MM", e.g. "2026-08"
  onChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleString("en-US", { month: "short" })
)

const FULL_MONTH_LABELS = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleString("en-US", { month: "long" })
)

export function MonthYearPicker({
  value,
  onChange,
  placeholder = "Select month",
  disabled,
  className,
}: MonthYearPickerProps) {
  const [open, setOpen] = React.useState(false)

  // Parse the YYYY-MM value
  const { selectedYear, selectedMonth } = React.useMemo(() => {
    if (!value) return { selectedYear: null, selectedMonth: null }
    const [yStr, mStr] = value.split("-")
    const y = parseInt(yStr, 10)
    const m = parseInt(mStr, 10) - 1 // convert 1-12 to 0-11
    return {
      selectedYear: isNaN(y) ? null : y,
      selectedMonth: isNaN(m) ? null : m,
    }
  }, [value])

  // Current year/month for cursor/default state
  const currentYear = new Date().getFullYear()

  // Year displayed in the popover header
  const [cursorYear, setCursorYear] = React.useState<number>(currentYear)

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (isOpen && selectedYear !== null) {
      setCursorYear(selectedYear)
    }
  }

  const handlePrevYear = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCursorYear((y) => y - 1)
  }

  const handleNextYear = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCursorYear((y) => y + 1)
  }

  const handleSelectMonth = (monthIndex: number) => {
    const formattedMonth = String(monthIndex + 1).padStart(2, "0")
    const newValue = `${cursorYear}-${formattedMonth}`
    if (onChange) {
      onChange(newValue)
    }
    setOpen(false)
  }

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onChange) {
      onChange("")
    }
    setOpen(false)
  }

  const handleToday = (e: React.MouseEvent) => {
    e.stopPropagation()
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, "0")
    if (onChange) {
      onChange(`${y}-${m}`)
    }
    setOpen(false)
  }

  // Format the button label
  const buttonLabel = React.useMemo(() => {
    if (selectedYear === null || selectedMonth === null) return placeholder
    const monthName = FULL_MONTH_LABELS[selectedMonth]
    return `${monthName} ${selectedYear}`
  }, [selectedYear, selectedMonth, placeholder])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            className={cn(
              "w-full justify-start text-left font-normal",
              !value && "text-muted-foreground",
              className
            )}
          >
            <IconCalendar data-icon="inline-start" className="mr-2 size-4" />
            {buttonLabel}
          </Button>
        }
      />
      <PopoverContent className="w-[240px] overflow-hidden p-3" align="center">
        <div className="flex flex-col gap-2">
          {/* Header */}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Previous year"
              onClick={handlePrevYear}
            >
              <IconChevronLeft className="size-4" />
            </Button>
            <span className="text-sm font-medium">{cursorYear}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Next year"
              onClick={handleNextYear}
            >
              <IconChevronRight className="size-4" />
            </Button>
          </div>

          {/* Grid of Months */}
          <div className="grid grid-cols-3 gap-1.5 pt-1">
            {MONTH_LABELS.map((monthLabel, i) => {
              const isSelected =
                selectedYear === cursorYear && selectedMonth === i
              return (
                <button
                  key={monthLabel}
                  type="button"
                  onClick={() => handleSelectMonth(i)}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-2.5 text-xs font-medium transition-colors",
                    isSelected
                      ? "bg-foreground font-semibold text-background"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {monthLabel}
                </button>
              )
            })}
          </div>

          {/* Footer Reset/Today */}
          <div className="mt-2 flex justify-between gap-2 border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="h-7 flex-1 cursor-pointer text-xs"
              onClick={handleReset}
            >
              Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="h-7 flex-1 cursor-pointer text-xs"
              onClick={handleToday}
            >
              Today
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
