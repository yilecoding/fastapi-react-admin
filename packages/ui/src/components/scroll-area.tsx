/**
 * Base UI 的 ScrollArea（覆盖式自绘滚动条）。**仓库里一个调用方都没有，也不要用。**
 *
 * 滚动条外观已经在 `styles/globals.css` 里用标准属性
 * （`scrollbar-width` / `scrollbar-color`）全站统一了 —— 一处 CSS 覆盖 69 个
 * 滚动容器，零 JS、零测量。换成这个组件要逐个替换，还会撞上六件事：
 *
 * 1. 它要**测量容器尺寸**算 thumb 大小，而多页签用 `<Activity>` 保活、
 *    隐藏 tab 是 `display:none`（宽度 0）—— 监控页的趋势线换掉 recharts、
 *    file-viewer 只在 Dialog 里挂，栽的都是这一个坑
 * 2. `_shared/settings-shell.tsx` 的 `IntersectionObserver` root 指向滚动容器；
 *    包一层之后真正滚的是内部 viewport div，root 得跟着往里挪
 * 3. `DataTable` 的 sticky 表头依赖滚动容器本身，多一层会改掉 sticky 的包含块
 * 4. `shell/tab-bar.tsx` 的「活动 tab 自动滚入视区」用的是原生 `scrollIntoView`
 * 5. 覆盖式滚动条会压住内容右边缘 —— 而「表格最右侧操作列被裁掉点不到」
 *    这个坑仓库里已经记过一次
 * 6. 键盘滚动、滚动锚定都要重新对一遍
 *
 * 留着它只是因为它是 Base UI 上游的一部分（`command.tsx` 同理，见 CLAUDE.md）。
 * 真需要覆盖式滚动条的场景（比如一个独立的、尺寸确定的浮层）再单独论证。
 */
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@admin/ui/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-s data-vertical:border-s-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
