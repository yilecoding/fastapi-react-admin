import { Checkbox } from '@admin/ui/components/checkbox'

/**
 * 表格首列的复选框。
 *
 * 各页的 `createColumnHelper<typeof features, T>()` 泛型互不相同，
 * 硬拿泛型串起来会掉进 TanStack v9 的类型方差坑（页面里已有 `columns as never`），
 * 所以这里只要求传进来的 helper 有 `display` 方法。
 */
type AnyColumnHelper = { display: (def: any) => any }

/** 是否可选由调用方决定（如超管行不允许删除时也不允许勾选） */
export function buildSelectColumn(col: AnyColumnHelper,
  opts: { canSelect?: (row: any) => boolean } = {},
  /**
   * 翻译函数由调用方传进来 —— 这是**普通函数**，在 `useMemo` 里被调用，
   * 自己 `useTranslation()` 会违反 Hooks 规则（React 会直接抛
   * "Should have a queue. You are likely calling Hooks conditionally"）。
   * 不传就回落到中文原文（key 本身）。
   */
  t: (k: string, vars?: Record<string, unknown>) => string = (k) => k
) {
  return col.display({
    id: 'select',
    enableHiding: false,
    header: ({ table }: any) => {
      const all = table.getIsAllPageRowsSelected()
      return (
        <Checkbox
          aria-label={t("全选本页")}
          data-testid="select-all"
          checked={all}
          // Base UI 的半选是独立的 indeterminate prop（显示横杠），
          // 不是 checked="indeterminate"
          indeterminate={!all && table.getIsSomePageRowsSelected()}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
        />
      )
    },
    cell: ({ row }: any) => {
      const allowed = opts.canSelect?.(row.original) ?? true
      return (
        <Checkbox
          aria-label={t("选中该行")}
          data-testid={`select-row-${row.id}`}
          checked={row.getIsSelected()}
          disabled={!allowed}
          onCheckedChange={(v) => row.toggleSelected(v === true)}
        />
      )
    },
  })
}
