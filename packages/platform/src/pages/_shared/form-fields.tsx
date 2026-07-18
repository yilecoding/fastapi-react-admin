import * as React from 'react'

import { FieldLegend, FieldSet } from '@admin/ui/components/field'
import { Label } from '@admin/ui/components/label'
import { Separator } from '@admin/ui/components/separator'
import { cn } from '@admin/ui/lib/utils'

/**
 * 抽屉表单的两个排版件：一个字段、一组字段。
 *
 * ## 为什么要有这个文件
 *
 * 之前 5 个表单**各写了一份**字段包裹件，其中三份字节级相同：
 *
 * ```
 * menu/form.tsx    Fld({label, error, required, children})   ┐
 * notice/form.tsx  F  ({label, error, required, children})   ├ 完全一样
 * dept/form.tsx    F  ({label, error, required, children})   ┘
 * config/form.tsx  Fld({label, error, required, hint, ...})  ← 多一个 hint
 * user/form.tsx    Field({label, error, required, ...})      ← 又换个名字
 * ```
 *
 * 五份副本的代价不是重复代码本身，是**改一处不会跟着走**：给字段加个 tooltip、
 * 换必填星号的样式、把错误文案接上 `role="alert"`，都得改 5 个文件，
 * 而漏掉一个不报错、只表现成「某个抽屉跟别的不一样」。
 *
 * ⚠️ `user/form.tsx` 里那个 `Field` **不是** `@admin/ui/components/field` 的
 * `Field` —— 同名的局部组件，API 完全不同（那个是 `ComponentProps<'div'>`，
 * 没有 label/error/required）。所以这里叫 `FormField`，不再和 `ui` 撞名。
 */

/**
 * 一个字段：标签在上、控件在下、错误在最下。
 *
 * 刻意**不复用** `ui` 的 `Field` —— 那个带 `role="group"` 和 `*:w-full`，
 * 会把里面的 Switch、单选组一并拉成整行宽。它服务的是另一种排版
 * （`date-picker` 那种水平/响应式布局），不是「抽屉里一列字段」。
 */
export function FormField({
  label,
  error,
  required,
  hint,
  className,
  children,
}: {
  label: string
  error?: string
  required?: boolean
  /** 常驻说明。**有 error 时让位** —— 两条一起显示会把行高顶起来又互相打架 */
  hint?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label>
        {label}
        {required && <span className="ms-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {hint && !error && <span className="text-xs text-muted-foreground">{hint}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

/**
 * 一组字段：`▌标题 ────────────`。
 *
 * ## 用 `fieldset` + `legend`，不是 div + 手画的线
 *
 * 视觉上一样，但读屏进到这几个输入框时会念「联系信息 分组」——
 * div 版念不出来，用户只能听到一串孤立的字段名。字段一多（菜单表单 12 个）
 * 这个差别就是「能不能听懂这个表单的结构」。
 *
 * 底座是 `ui/components/field.tsx` 的 `FieldSet` / `FieldLegend`（shadcn 那套）。
 * 它们在这之前是**零调用方**的死代码 —— 与其另起第三条路，不如把它们接上。
 *
 * ## 三个只有动手才知道的点
 *
 * 1. **`variant="label"` 不能省。** `FieldLegend` 的基础类是
 *    `data-[variant=legend]:text-base`（带属性前缀），而我们要 `text-sm`。
 *    直接 `className="text-sm"` 是**无效**的 —— 前缀不同就不算冲突，
 *    twMerge 不消解，两条都进 class 属性，然后属性选择器 (0,2,0)
 *    必胜纯 utility (0,1,0)。走它自己的 `variant` prop 才对。
 *    （CLAUDE.md「为什么有些覆盖有效、有些无声失效」那一节）
 * 2. **`fieldset` 要 `min-w-0`。** UA 样式给它 `min-inline-size: min-content`，
 *    正是「`min-width:auto` 是横向溢出的元凶」的同族 —— 里面放两列网格时
 *    它会拒绝收缩，把抽屉顶出横向滚动条。
 * 3. **`legend` 要显式 `w-full`。** legend 的宽度默认收缩包裹内容，
 *    不给宽度那条分隔线只会占标题那么长，`flex-1` 撑不开。
 * 4. **`legend` 不参与 flex 的 `gap`，间距只能靠 margin。** 它是 fieldset 的
 *    「渲染图例」，被单独摆在盒子顶端，不是普通 flex 子项。第一版把
 *    `mb-0` 交给 `FieldSet` 的 `gap-4` 去管，实测标题和它下面第一个字段
 *    几乎贴在一起（约 4px，而字段之间是 16px）—— 分节头看着像那个字段的
 *    第二行标签，分组的层级完全读不出来。
 *
 * 三层间距是刻意排的：**标题→首个字段 12px < 字段→字段 16px < 组→组 24px**。
 * 标题必须比字段间距更贴近自己的内容，否则它看起来属于上一组。
 */
export function FormSection({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <FieldSet className={cn('min-w-0 gap-4', className)}>
      <FieldLegend variant="label" className="mb-3 flex w-full items-center gap-2">
        {/* 强调条用 bg-primary，跟着主题色走 —— 在偏好设置里换主色它跟着变，不写死蓝 */}
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
        <span className="shrink-0">{title}</span>
        <Separator className="ms-1 min-w-0 flex-1" />
      </FieldLegend>
      {children}
    </FieldSet>
  )
}
