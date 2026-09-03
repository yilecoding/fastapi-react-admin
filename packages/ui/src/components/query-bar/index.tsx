"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconLoader2, IconRotate, IconSearch } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { ToggleGroup, ToggleGroupItem } from "@admin/ui/components/toggle-group"
import { cn } from "@admin/ui/lib/utils"

import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"

import { AdvancedFilter } from "./advanced"
import { BasicFilter, FieldPicker } from "./basic"
import { packQuery } from "./params"
import {
  emptyGroup, emptyQuery,
  type ConditionGroup, type FilterField, type QueryMode, type QueryValue,
} from "./types"
import { validateQuery, type QueryError, type ValidateContext } from "./validate"
import { countActive } from "./value"
import { QueryViews, useQueryViews, type QueryView } from "./views"

/** 超过这么多个条件格就折叠 —— 十几格铺三行会把表格顶下去 */
const DEFAULT_COLLAPSE_AFTER = 8

export type QueryBarProps = {
  /** 可筛字段的声明。加一个筛选项 = 这里加一项，组件自己管 UI */
  fields: readonly FilterField[]
  value: QueryValue
  onChange: (v: QueryValue) => void
  /** 点「搜索」或按回车才触发 —— 边输边查会把服务端打爆，也让人没法组合多个条件 */
  onSearch: (v: QueryValue) => void
  onReset?: () => void

  /**
   * 「已经生效的那一份」。给了它，「有未应用的改动」就是**算出来**的而不是猜的。
   *
   * 不给也能用（组件自己记住最后一次 `onSearch` 发出去的那份），但那样在
   * **页面从外部换掉 `value`** 时会误报 —— 换 URL、切租户、字段集合变了都会。
   * 页面本来就持有这两份（编辑中的 + 已提交的），传一下最省事。
   */
  applied?: QueryValue

  /** 允许切到高级模式（AND/OR + 嵌套分组）。后端没有过滤 DSL 时**别开** */
  advanced?: boolean

  /** 传了就启用筛选视图，值是 localStorage 的 key */
  viewsStorageKey?: string
  /** 视图受控（要落库/团队共享时用）。给了这两个就不碰 localStorage */
  views?: readonly QueryView[]
  onViewsChange?: (next: QueryView[]) => void

  /**
   * 动作行**左侧**那一组（调用方的动作：新增 / 导出 / 清空 / 列显隐…）。
   *
   * 靠左是刻意的：这些是**页面级动作**，位置应该固定，不随条件多少上下漂移；
   * 右边留给查询区自己的「视图 / 搜索 / 重置」。两组之间由状态行的
   * `me-auto` 撑开，不用画分隔线。
   *
   * 页面同时有 `DataTable` 时**把表格那一行也并到这里**（`DataTable` 传
   * `showColumnVisibility={false}`，它的工具行就整行消失）——
   * 不并的话是两条右对齐、左半边全空的按钮行叠在一起，白占 40px
   * （用户截图指出过）。查询区自己的那一组（视图 / 搜索 / 重置）在它右边。
   */
  actions?: React.ReactNode
  loading?: boolean
  className?: string

  /** 基础模式超过这么多条就折叠，默认 8 */
  collapseAfter?: number
  /** 业务侧补充校验（「时间跨度不能超过 90 天」这类），返回 `undefined` 表示没问题 */
  validate?: (ctx: ValidateContext) => QueryError | undefined
}

/**
 * 列表页顶部查询区。
 *
 * 五条设计取舍，都是照着「一天要用几十次」来定的：
 *
 * 1. **默认不铺字段。** 传统查询表单一上来摆 8 个空输入框，占掉小半屏、
 *    视觉噪音大，而每次实际只用一两个。这里只显示 `defaultVisible` 的，
 *    其余从「添加条件」按需挑。
 * 2. **搜索是显式动作**（点按钮或**按回车**）。不做输入即查：多条件要组合完再发，
 *    而且服务端分页的接口经不起每敲一个字符打一次。
 * 3. **值的归属在调用方。** 组件是受控的，`value` 由页面持有 →
 *    页面把它写进 URL search params（硬纪律 2：视图状态必须能跨刷新恢复）。
 *    整份查询用 `packQuery` / `unpackQuery`，发给后端用 `toQueryParams`。
 * 4. **改了没搜要说出来。** 显式搜索的代价是「以为改完就生效了」，
 *    所以有未应用的改动时下面那行会明说，而不是静静地显示旧结果。
 * 5. **查得出来的错在点搜索之前拦住。**「介于 100 和 10」后端会老实照办、
 *    返回空列表，看起来和「没数据」一模一样。
 */
export function QueryBar({
  fields,
  value,
  onChange,
  onSearch,
  onReset,
  advanced,
  viewsStorageKey,
  views: controlledViews,
  onViewsChange,
  actions,
  loading,
  className,
  collapseAfter,
  validate,
  applied,
}: QueryBarProps) {
  const { t } = useTranslation()
  const [storedViews, setStoredViews] = useQueryViews(controlledViews ? undefined : viewsStorageKey)
  const views = controlledViews ?? storedViews
  const setViews = onViewsChange ?? setStoredViews
  const viewsOn = Boolean(viewsStorageKey || controlledViews)
  const [activeView, setActiveView] = React.useState<string | undefined>()
  const [expanded, setExpanded] = React.useState(false)

  /** 超过 `collapseAfter` 的条件格先不渲染 —— 十几格铺三行会把表格顶下去 */
  const hiddenCount = Math.max(0, value.basic.length - (collapseAfter ?? DEFAULT_COLLAPSE_AFTER))
  const visibleCount = expanded || hiddenCount === 0 ? undefined : (collapseAfter ?? DEFAULT_COLLAPSE_AFTER)

  /**
   * 「已经搜过的那一份」的指纹。用 `packQuery` 而不是 `JSON.stringify(value)` ——
   * 后者带着条件 id，而 id 每次 `emptyQuery` / 换字段都会变，
   * 于是刚点完搜索就显示「有未应用的改动」。
   */
  const signature = React.useMemo(() => packQuery(value) ?? "", [value])
  const [searched, setSearched] = React.useState(signature)
  const appliedSignature = React.useMemo(
    () => (applied ? (packQuery(applied) ?? "") : undefined),
    [applied]
  )
  const dirty = signature !== (appliedSignature ?? searched)

  const errors = React.useMemo(
    () => validateQuery(value, fields, validate),
    [value, fields, validate]
  )
  const errorCount = Object.keys(errors).length

  const active = countActive(value, fields)
  const setMode = (mode: QueryMode) => onChange({ ...value, mode })

  const submit = React.useCallback(
    (next: QueryValue = value) => {
      // 有错就不发。按钮已经禁用了，但回车也走这条路
      if (Object.keys(validateQuery(next, fields, validate)).length) return
      setSearched(packQuery(next) ?? "")
      onSearch(next)
    },
    [value, fields, validate, onSearch]
  )

  // 有默认视图就在首次进来时套用；之后用户手动改了就不再干预
  const defaultViewApplied = React.useRef(false)
  React.useEffect(() => {
    if (defaultViewApplied.current || !views.length) return
    defaultViewApplied.current = true
    const def = views.find((v) => v.isDefault)
    if (!def) return
    // 首次载入时套用默认视图（由上面的 ref 保证只跑一次）。「默认视图」是从
    // 服务端拿到 `views` 之后才知道的，没有更早的时机可用。
    setActiveView(def.id)
    onChange(def.value)
    setSearched(packQuery(def.value) ?? "")
    onSearch(def.value)
    // onChange/onSearch 故意不进依赖：只在视图首次载入时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views])

  const reset = () => {
    const blank: QueryValue = { ...emptyQuery(fields), mode: value.mode }
    setActiveView(undefined)
    onChange(blank)
    setSearched(packQuery(blank) ?? "")
    if (onReset) onReset()
    else onSearch(blank)
  }

  const applyView = (v: QueryView) => {
    setActiveView(v.id)
    onChange(v.value)
    setSearched(packQuery(v.value) ?? "")
    onSearch(v.value)
  }

  return (
    <div
      /**
       * `@container/qb` 是给条件网格的列数用的 —— 查询区的可用宽度取决于它被塞在
       * 哪儿（页面主区、卡片里、抽屉里），跟视口宽度没关系，所以用容器查询
       * 而不是 `sm:` / `md:`。
       */
      className={cn("@container/qb flex flex-col gap-2", className)}
      data-testid="query-bar"
      data-mode={value.mode}
      data-dirty={dirty || undefined}
      role="search"
    >
      {/*
        🔴 **条件区独占整宽，动作区独占一行。**
        第一版把两者塞进同一个 flex row：动作区（新增 + 模式切换 + 视图 +
        搜索 + 重置）约 500px 钉在第一行右侧，条件区只剩下不到 320px ——
        于是每个条件各占一行、`w-72` 的时间区间还被压得字段名竖排。
        分成两行之后布局与条件数无关，永远可预测。
      */}
      {value.mode === "basic" ? (
        <BasicFilter
          fields={fields}
          conditions={value.basic}
          visibleCount={visibleCount}
          onChange={(basic) => onChange({ ...value, basic })}
          onSubmit={submit}
          errors={errors}
        />
      ) : (
        <AdvancedFilter
          fields={fields}
          group={value.advanced}
          onChange={(next: ConditionGroup) => onChange({ ...value, advanced: next })}
          onSubmit={submit}
          errors={errors}
        />
      )}

      {/*
        动作行分两组，中间靠 `me-auto` 撑开：
        **左边是调用方的**（新增 / 导出 / 清空 / 列 —— 页面级的动作，位置固定，
        不随条件多少漂移），**右边是查询区自己的**（视图 / 搜索 / 重置）。
        原来 `actions` 挤在右边和搜索并排，六个按钮连成一片，
        「哪个是主动作」得逐个认。
      */}
      <div className="flex flex-wrap items-center gap-2">
        {actions}

        {/* 状态行跟在左组后面，靠 `me-auto` 把右组顶到最右。
            放左边而不是紧挨「搜索」：它出现/消失时右组的位置不会跳。
            三者互斥，一次只说最要紧的那一句。 */}
        <div className="me-auto min-w-0">
          {errorCount > 0 ? (
            <span className="flex items-center gap-1.5 text-xs text-destructive" data-testid="qb-status">
              <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
              {t("{{n}} 个条件填得不对", { n: errorCount })}
            </span>
          ) : dirty ? (
            /* 用「灰字 + 琥珀小点」而不是整句橙字：这是提示不是错误，
               一整句橙色比它旁边的主按钮还抢眼（用户截图里就是这样） */
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="qb-status">
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
              {t("条件已改，按回车应用")}
            </span>
          ) : active > 0 ? (
            <span className="text-xs text-muted-foreground" data-testid="qb-status">
              {t("{{n}} 个条件生效", { n: active })}
              {value.mode === "advanced" &&
                `（${value.advanced.logic === "and" ? t("全部满足") : t("任一满足")}）`}
            </span>
          ) : null}
        </div>

        {/*
          「添加条件」和折叠按钮属于**查询区自己的**控件，所以排在右组开头。
          放条件网格里的话，条件数恰好等于列数时（用户管理页 5 个条件撞上 5 列）
          它会独占第二行的一格，而且网格行数随条件数忽多忽少 —— 现在永远两行。
        */}
        {value.mode === "basic" && hiddenCount > 0 && (
          <Button
            variant="ghost" size="sm" className="h-8 text-muted-foreground"
            data-testid="qb-collapse"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
            {expanded ? t("收起") : t("展开 {{n}} 项", { n: hiddenCount })}
          </Button>
        )}
        {value.mode === "basic" && (
          <FieldPicker
            fields={fields}
            conditions={value.basic}
            onChange={(basic) => onChange({ ...value, basic })}
          />
        )}

        {advanced && (
          <ToggleGroup
            value={[value.mode]}
            onValueChange={(v: string[]) => { if (v.length) setMode(v[0] as QueryMode) }}
            variant="outline" size="sm" spacing={0}
            data-testid="qb-mode"
          >
            {/* 字号不覆盖：Toggle 基础类是 text-sm，写成 text-xs 之后它和紧邻的
                「搜索 / 重置」（Button 基础类 text-sm）差一号，一排按钮里两种字号 */}
            <ToggleGroupItem value="basic" className="h-8 px-2" data-testid="qb-mode-basic">
              {t("基础筛选")}
            </ToggleGroupItem>
            <ToggleGroupItem value="advanced" className="h-8 px-2" data-testid="qb-mode-advanced">
              {t("高级筛选")}
            </ToggleGroupItem>
          </ToggleGroup>
        )}

        {viewsOn && (
          <QueryViews
            views={views}
            current={value}
            activeId={activeView}
            dirty={dirty}
            local={!controlledViews}
            onApply={applyView}
            onChange={setViews}
          />
        )}

        <Button
          size="sm" className="h-8"
          disabled={loading || errorCount > 0}
          onClick={() => submit()}
          data-testid="qb-search"
        >
          {loading
            ? <IconLoader2 className="size-4 animate-spin" />
            : <IconSearch className="size-4" />}
          {t("搜索")}
        </Button>
        <Button
          variant="outline" size="sm" className="h-8"
          disabled={active === 0 && !activeView && !dirty}
          onClick={reset}
          data-testid="qb-reset"
        >
          <IconRotate className="size-4" />
          {t("重置")}
        </Button>
      </div>
    </div>
  )
}

export { emptyGroup, emptyQuery }
export {
  OPERATOR_LABEL, RANGE_OPS, RANGE_TYPES, TYPE_OPERATORS, VALUELESS,
  defaultOperatorOf, isGroup, newCondition, nextId, operatorsOf, valueShape,
  type Condition, type ConditionGroup, type FieldControlContext, type FieldType,
  type FilterField, type FilterOption, type Operator, type QueryMode, type QueryValue,
  type ValueShape,
} from "./types"
export {
  countActive, hasValue, indexFields, migrateValue, pruneUnknown, withField, withOperator,
} from "./value"
export {
  LAYOUT_PARAM, TREE_PARAM,
  conditionParams, fromUrlParams, packQuery, rangeParamNames, toFilterTree, toQueryParams,
  toUrlParams, unpackQuery, urlParamKeys,
} from "./params"
export {
  validateCondition, validateQuery,
  type QueryError, type QueryErrors, type ValidateContext,
} from "./validate"
export { FieldControl, TagsInput } from "./field-control"
export { BasicFilter } from "./basic"
export { AdvancedFilter } from "./advanced"
export { QueryViews, useQueryViews, type QueryView } from "./views"
