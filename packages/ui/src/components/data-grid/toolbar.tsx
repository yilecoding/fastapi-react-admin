"use client"

import * as React from "react"
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconFilterOff,
  IconFoldDown,
  IconFoldUp,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@admin/ui/components/input-group"
import { Separator } from "@admin/ui/components/separator"
import { ToggleGroup, ToggleGroupItem } from "@admin/ui/components/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@admin/ui/components/tooltip"
import { cn } from "@admin/ui/lib/utils"

import { DataGridColumnSettings } from "./column-settings"
import { GRID_DENSITIES, GRID_DENSITY, type GridDensity } from "./density"

export type GridToolbarCaps = {
  search?: boolean
  density?: boolean
  columnSettings?: boolean
  refresh?: boolean
  clearFilters?: boolean
  expandToggle?: boolean
  fullscreen?: boolean
}

/**
 * 表格工具栏。
 *
 * 左边是**业务筛选**（调用方塞进 `children`），右边是**表格自己的能力**。
 * 这条分界线很重要：左边的东西改的是「取哪些数据」（多数要写进 URL），
 * 右边的改的是「怎么看这些数据」（本地偏好）。混在一起用户会分不清哪些操作会丢。
 */
export function DataGridToolbar({
  table,
  caps,
  columnLabels,
  density,
  onDensityChange,
  search,
  onSearchChange,
  searchPlaceholder = "搜索…",
  onRefresh,
  refreshing,
  fullscreen,
  onFullscreenChange,
  children,
  actions,
}: {
  table: any
  caps: GridToolbarCaps
  columnLabels?: Record<string, string>
  density: GridDensity
  onDensityChange: (d: GridDensity) => void
  search?: string
  onSearchChange?: (v: string) => void
  searchPlaceholder?: string
  onRefresh?: () => void
  refreshing?: boolean
  fullscreen?: boolean
  onFullscreenChange?: (v: boolean) => void
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  const [localSearch, setLocalSearch] = React.useState(search ?? "")
  React.useEffect(() => setLocalSearch(search ?? ""), [search])

  const canExpand = typeof table.toggleAllRowsExpanded === "function"
  const allExpanded = canExpand ? table.getIsAllRowsExpanded?.() : false
  // ⚠️ v9 没有 `table.getState()`（那是 v8 的 API），受控状态在 `table.options.state` 上。
  // 全局搜索这里直接看受控的 `search` prop，比绕一圈读 table 更直接。
  const hasFilters =
    Boolean(search) ||
    ((table.options?.state?.columnFilters?.length ?? 0) > 0)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}

      <div className="ms-auto flex flex-wrap items-center gap-2">
        {actions}

        {caps.search && onSearchChange && (
          <InputGroup className="h-8 w-56">
            <InputGroupAddon align="inline-start">
              <IconSearch className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              value={localSearch}
              placeholder={searchPlaceholder}
              data-testid="grid-search"
              onChange={(e) => {
                setLocalSearch(e.target.value)
                onSearchChange(e.target.value)
              }}
            />
          </InputGroup>
        )}

        {caps.density && (
          <ToggleGroup
            value={[density]}
            onValueChange={(v: string[]) => { if (v.length) onDensityChange(v[0] as GridDensity) }}
            variant="outline"
            size="sm"
            spacing={0}
            data-testid="grid-density"
          >
            {GRID_DENSITIES.map((d) => (
              <ToggleGroupItem key={d} value={d} className="h-8 px-2 text-xs" data-testid={`grid-density-${d}`}>
                {GRID_DENSITY[d].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}

        {(caps.clearFilters || caps.expandToggle || caps.refresh) && (caps.density || caps.search) && (
          <Separator orientation="vertical" className="data-[orientation=vertical]:h-5" />
        )}

        {caps.clearFilters && (
          <IconBtn
            label="清空筛选"
            testId="grid-clear-filters"
            disabled={!hasFilters}
            onClick={() => {
              table.resetColumnFilters?.()
              table.resetGlobalFilter?.()
              onSearchChange?.("")
            }}
          >
            <IconFilterOff className="size-4" />
          </IconBtn>
        )}

        {caps.expandToggle && canExpand && (
          <IconBtn
            label={allExpanded ? "全部折叠" : "全部展开"}
            testId="grid-expand-toggle"
            onClick={() => table.toggleAllRowsExpanded(!allExpanded)}
          >
            {allExpanded ? <IconFoldUp className="size-4" /> : <IconFoldDown className="size-4" />}
          </IconBtn>
        )}

        {caps.refresh && onRefresh && (
          <IconBtn label="刷新" testId="grid-refresh" onClick={onRefresh}>
            <IconRefresh className={cn("size-4", refreshing && "animate-spin")} />
          </IconBtn>
        )}

        {caps.columnSettings && <DataGridColumnSettings table={table} labels={columnLabels} />}

        {caps.fullscreen && onFullscreenChange && (
          <IconBtn
            label={fullscreen ? "退出全屏" : "全屏"}
            testId="grid-fullscreen"
            onClick={() => onFullscreenChange(!fullscreen)}
          >
            {fullscreen ? <IconArrowsMinimize className="size-4" /> : <IconArrowsMaximize className="size-4" />}
          </IconBtn>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  label, testId, onClick, disabled, children,
}: {
  label: string
  testId: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline" size="icon" className="size-8"
            aria-label={label} disabled={disabled} onClick={onClick}
          />
        }
        data-testid={testId}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
