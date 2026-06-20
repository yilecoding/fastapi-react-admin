"use client"

import * as React from "react"
import { IconCalendar } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Calendar } from "@admin/ui/components/calendar"
import { Field, FieldLabel } from "@admin/ui/components/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@admin/ui/components/popover"
import { cn } from "@admin/ui/lib/utils"

export function DatePicker({
  date: controlledDate,
  onSelect: controlledOnSelect,
  placeholder = "Select date",
  id,
  disabled,
  className,
  label = "Date of birth",
  showField = false,
}: {
  date?: Date
  onSelect?: (date: Date | undefined) => void
  placeholder?: string
  id?: string
  disabled?: boolean
  className?: string
  label?: string
  showField?: boolean
} = {}) {
  const [open, setOpen] = React.useState(false)
  const [internalDate, setInternalDate] = React.useState<Date | undefined>(
    undefined
  )

  const date = controlledDate !== undefined ? controlledDate : internalDate
  const setDate = (d: Date | undefined) => {
    if (controlledOnSelect) {
      controlledOnSelect(d)
    } else {
      setInternalDate(d)
    }
  }

  const trigger = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            id={id}
            disabled={disabled}
            className={cn(
              "w-full justify-start text-left font-normal",
              !date && "text-muted-foreground",
              className
            )}
          >
            <IconCalendar data-icon="inline-start" className="mr-2 size-4" />
            {date ? date.toLocaleDateString() : placeholder}
          </Button>
        }
      />
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date || new Date()}
          captionLayout="dropdown"
          onSelect={(date) => {
            setDate(date)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )

  if (showField) {
    return (
      <Field className="mx-auto w-44">
        <FieldLabel htmlFor={id || "date"}>{label}</FieldLabel>
        {trigger}
      </Field>
    )
  }

  return trigger
}
