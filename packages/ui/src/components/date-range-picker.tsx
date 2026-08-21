"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { format } from "date-fns"
import { IconCalendar } from "@tabler/icons-react"
import { type DateRange } from "react-day-picker"

import { Button } from "@admin/ui/components/button"
import { Calendar } from "@admin/ui/components/calendar"
import { Field, FieldLabel } from "@admin/ui/components/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@admin/ui/components/popover"
import { cn } from "@admin/ui/lib/utils"

export function DateRangePicker({
  date: controlledDate,
  onSelect: controlledOnSelect,
  id,
  disabled,
  className,
  label = "Date Picker Range",
  placeholder,
  showField = false,
}: {
  date?: DateRange
  onSelect?: (date: DateRange | undefined) => void
  id?: string
  disabled?: boolean
  className?: string
  label?: string
  placeholder?: string
  showField?: boolean
} = {}) {
  const { t } = useTranslation()
  // 原实现写死了一个 demo 默认区间（今年 1/20 起 20 天），
  // 且判定是 `controlledDate !== undefined ? controlledDate : internalDate` ——
  // 受控用法传 undefined（表示「未选择」）时会回退到那个假区间，
  // 界面上看着有筛选、实际没应用，是个会误导人的 bug。
  // 改为：给了 onSelect 就完全受控；非受控时默认无选择。
  const [internalDate, setInternalDate] = React.useState<DateRange | undefined>(undefined)

  const isControlled = controlledOnSelect !== undefined
  const date = isControlled ? controlledDate : internalDate
  const setDate = (d: DateRange | undefined) => {
    if (controlledOnSelect) {
      controlledOnSelect(d)
    } else {
      setInternalDate(d)
    }
  }

  const trigger = (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            id={id}
            disabled={disabled}
            className={cn(
              "w-full justify-start px-2.5 text-left font-normal",
              !date && "text-muted-foreground",
              className
            )}
          >
            <IconCalendar data-icon="inline-start" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "LLL dd, y")} -{" "}
                  {format(date.to, "LLL dd, y")}
                </>
              ) : (
                format(date.from, "LLL dd, y")
              )
            ) : (
              <span>{placeholder ?? t('选择日期范围')}</span>
            )}
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          defaultMonth={date?.from}
          selected={date}
          onSelect={setDate}
          numberOfMonths={2}
        />
        {date?.from && (
          <div className="flex justify-end border-t border-border p-2">
            <Button variant="ghost" size="sm" onClick={() => setDate(undefined)}>
              {t('清除')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )

  if (showField) {
    return (
      <Field className="mx-auto w-60">
        <FieldLabel htmlFor={id || "date-picker-range"}>{label}</FieldLabel>
        {trigger}
      </Field>
    )
  }

  return trigger
}
