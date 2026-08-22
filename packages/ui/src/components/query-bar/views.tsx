"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  IconBookmark, IconCheck, IconDeviceFloppy, IconPencil, IconStar, IconStarFilled, IconTrash,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Input } from "@admin/ui/components/input"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

import type { QueryValue } from "./types"

export type QueryView = {
  id: string
  name: string
  value: QueryValue
  isDefault?: boolean
}

function readViews(storageKey?: string): QueryView[] {
  if (!storageKey || typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(storageKey)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? (parsed as QueryView[]) : []
  } catch {
    /* 存坏了就当没有，不要因为一份脏数据把整页拖垮 */
    return []
  }
}

/**
 * 筛选视图：把当前这套条件存成一个名字，下次一键切回来。
 *
 * 存在 localStorage 而不是后端：这是**个人的常用查询**，不是团队共享的配置 ——
 * 跟着人走不跟着账号走已经够用，也省掉一张表和一套接口。
 * 真要团队共享，把 `views` / `onViewsChange` 受控传进来即可（`QueryBar` 已经
 * 透出这两个 prop），组件本身不关心它们存在哪。
 *
 * 🔴 **视图里存的是整份 `QueryValue`，所以条件值必须是 JSON 原样往返的。**
 * 放 `Date` 的话 `JSON.stringify` 出去是 ISO 串、`JSON.parse` 回来还是串，
 * 存进去当场能用、下次读回来裂 —— 是最难查的那一类。见 `types.ts` 顶部那段。
 */
export function useQueryViews(storageKey?: string) {
  /**
   * 首帧就读出来（惰性 initializer），**不用 effect**。
   *
   * 用 effect 的话视图会晚一帧到位，而 `QueryBar` 里「套用默认视图」那段
   * 正好等着它 —— 表现是进页面先闪一下空筛选再跳成默认视图。
   * 代价：`storageKey` 运行时换掉不会重读。它是常量（`'qb:users'` 这种），不换。
   */
  const [views, setViews] = React.useState<QueryView[]>(() => readViews(storageKey))

  const persist = React.useCallback(
    (next: QueryView[]) => {
      setViews(next)
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(next))
        } catch {
          /* 隐私模式写不了，内存态照常 */
        }
      }
    },
    [storageKey]
  )

  return [views, persist] as const
}

export function QueryViews({
  views,
  current,
  activeId,
  dirty,
  local,
  onApply,
  onChange,
}: {
  views: readonly QueryView[]
  current: QueryValue
  activeId?: string
  /** 当前条件和选中视图不一致 —— 决定要不要提示「覆盖」 */
  dirty?: boolean
  /**
   * 视图只存在这台机器上（走 localStorage，没有受控接管）。
   *
   * 这一条**必须在界面上说出来**：不说的话它看起来就是跟着账号走的，
   * 换台电脑发现视图没了才反应过来 —— 那时人已经存了十几个。
   */
  local?: boolean
  onApply: (v: QueryView) => void
  onChange: (next: QueryView[]) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState("")
  const [renaming, setRenaming] = React.useState<string | undefined>()
  const [renameText, setRenameText] = React.useState("")
  const active = views.find((v) => v.id === activeId)

  /** 重名会让下拉里出现两个一模一样的条目，谁也分不出点哪个 */
  const dup = (n: string, exceptId?: string) =>
    views.some((v) => v.id !== exceptId && v.name === n)

  const saveAs = () => {
    const n = name.trim()
    if (!n || dup(n)) return
    // id 用时间戳：视图是个人的、量级十几个，不会撞
    onChange([...views, { id: `v${Date.now()}`, name: n, value: current }])
    setName("")
  }

  const commitRename = () => {
    const n = renameText.trim()
    if (n && !dup(n, renaming)) {
      onChange(views.map((v) => (v.id === renaming ? { ...v, name: n } : v)))
    }
    setRenaming(undefined)
  }

  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" size="sm" className="h-8 max-w-40" aria-label={t("筛选视图")} />}
        data-testid="qb-views"
      >
        <IconBookmark className="size-4 shrink-0" />
        <span className="truncate">{active ? active.name : t("筛选视图")}</span>
        {active && dirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        {views.length > 0 && (
          <>
            <div className="max-h-56 overflow-y-auto">
              {views.map((v) => (
                <div
                  key={v.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-sm px-2 py-1.5 text-sm hover:bg-muted",
                    v.id === activeId && "bg-muted"
                  )}
                  data-testid={`qb-view-${v.id}`}
                >
                  {renaming === v.id ? (
                    <Input
                      autoFocus
                      className="h-7"
                      value={renameText}
                      data-testid={`qb-view-rename-input-${v.id}`}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename()
                        if (e.key === "Escape") setRenaming(undefined)
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-start"
                        onClick={() => onApply(v)}
                      >
                        {v.id === activeId
                          ? <IconCheck className="size-3.5 shrink-0" />
                          : <span className="size-3.5 shrink-0" />}
                        <span className="truncate">{v.name}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={t("重命名")}
                        data-testid={`qb-view-rename-${v.id}`}
                        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                        onClick={() => { setRenaming(v.id); setRenameText(v.name) }}
                      >
                        <IconPencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={v.isDefault ? t("取消默认") : t("设为默认")}
                        data-testid={`qb-view-default-${v.id}`}
                        className={cn(
                          "shrink-0 text-muted-foreground hover:text-foreground",
                          v.isDefault && "text-amber-500"
                        )}
                        onClick={() =>
                          onChange(views.map((x) => ({ ...x, isDefault: x.id === v.id ? !v.isDefault : false })))
                        }
                      >
                        {v.isDefault ? <IconStarFilled className="size-3.5" /> : <IconStar className="size-3.5" />}
                      </button>
                      <button
                        type="button"
                        aria-label={t("删除视图")}
                        data-testid={`qb-view-del-${v.id}`}
                        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                        onClick={() => onChange(views.filter((x) => x.id !== v.id))}
                      >
                        <IconTrash className="size-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <Separator className="my-1" />
          </>
        )}

        {/* 有改动时「覆盖」排在「另存为」前面 —— 调完筛选想存回去是更常见的动作 */}
        {active && dirty && (
          <Button
            variant="ghost" size="sm" className="h-8 w-full justify-start"
            data-testid="qb-view-overwrite"
            onClick={() => onChange(views.map((v) => (v.id === active.id ? { ...v, value: current } : v)))}
          >
            <IconDeviceFloppy className="size-4" />
            {t("覆盖「{{name}}」", { name: active.name })}
          </Button>
        )}

        <div className="flex items-center gap-1 p-1">
          <Input
            className="h-8"
            value={name}
            placeholder={t("视图名称")}
            data-testid="qb-view-name"
            aria-invalid={Boolean(name.trim()) && dup(name.trim())}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveAs()}
          />
          <Button
            size="sm" className="h-8 shrink-0"
            disabled={!name.trim() || dup(name.trim())}
            onClick={saveAs}
            data-testid="qb-view-saveas"
          >
            {t("另存为")}
          </Button>
        </div>
        {Boolean(name.trim()) && dup(name.trim()) && (
          <p className="px-2 pb-1 text-xs text-destructive">{t("已有同名视图")}</p>
        )}

        {local && (
          <>
            <Separator className="my-1" />
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {t("视图只存在这台电脑上，换设备或清缓存会丢失")}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
