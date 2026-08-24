import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAdjustments, IconAlertTriangle, IconClock, IconCode, IconKey, IconLock,
  IconLockAccess, IconLogin, IconPlus, IconRestore, IconSearch, IconServer,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@admin/ui/components/input-group'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'

import { Can } from '../../auth/can'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { StatusPill } from '../_shared/status'
import {
  configsQuery, isGroupSwitch, isSecret, toBody,
  useDeleteConfigs, useSaveConfigs, type ConfigItem,
} from './api'
import { ConfigSheet } from './form'
import { ConfigNav, navDesc, railIcon } from './nav'
import {
  UNMANAGED_SECTION, metaOf, railIdOf, railItem,
  sectionRank, sectionSummary, validateCross, validateOne,
} from './registry'
import { SettingRow } from './setting-row'

/**
 * 小节图标——和个人中心 `Block` 的图标徽标同一个视觉语言
 * （`bg-primary/10 text-primary` 的圆角方块）。放在这里而不是 `registry.ts`：
 * 注册表刻意保持纯数据，不 import React，图标这种渲染层的东西留在页面文件里查表。
 * 兜底给 `IconAdjustments`——新增小节或落进「未纳管的键」都不会漏成一个空位。
 */
const SECTION_ICONS: Record<string, React.ReactNode> = {
  '开发工具': <IconCode />,
  '登录校验': <IconLogin />,
  '口令强度': <IconLock />,
  '有效期与提醒': <IconClock />,
  '账号锁定': <IconLockAccess />,
  '服务器': <IconServer />,
  '认证': <IconKey />,
}
const sectionIcon = (title: string): React.ReactNode => SECTION_ICONS[title] ?? <IconAdjustments />

/**
 * 参数配置 —— **左右结构的设置屏**，不是键值对表格。
 *
 * 为什么不用表格：表格是给多行同构数据用的，而设置项是一堆异构单值。
 * 上一版用 `DataTable` 的结果是「分组」列在分组页签里重复 17 遍、
 * 「来源」列 17 行全一样、最该读的说明被截断在最右侧，
 * 而且排序退化成键名字母序把相关项打散了（`有效期` 和 `到期提醒`
 * 中间隔着 `历史检查次数`/`最大长度`/`最小长度`）。
 *
 * 现在的结构：
 *   左栏分类（registry.ts: RAIL）│ 右侧按小节分段，每段一行行「标签 + 控件」
 *   顶部粘性栏：搜索 + 未保存计数 + 保存/放弃
 *
 * 硬纪律：组件 router-独立（search 走 props）；分类与搜索词进 URL。
 * **没有分页** —— 所以 route schema 里也不能留 `page`/`size`（见 CLAUDE.md 组件约定）。
 */
export type ConfigSearch = {
  /** 左栏选中的分类：LOGIN / USER_SECURITY / EMAIL / AI / other */
  group?: string
  /** 名称 / 键名 / 说明关键字 */
  q?: string
}

export function ConfigPage({
  search = {},
  onSearchChange,
}: {
  search?: ConfigSearch
  onSearchChange?: (n: ConfigSearch) => void
}) {
  const { t } = useTranslation()
  const { data, isPending } = useQuery(configsQuery)
  const all = React.useMemo(() => data ?? [], [data])

  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [localQ, setLocalQ] = React.useState(search.q ?? '')
  React.useEffect(() => setLocalQ(search.q ?? ''), [search.q])

  const patch = React.useCallback(
    (n: Partial<ConfigSearch>) => onSearchChange?.({ ...search, ...n }),
    [onSearchChange, search]
  )

  /** 当前值 = 草稿优先。**不要**用 useEffect 把服务端值同步进草稿 */
  const valueOf = React.useCallback((c: ConfigItem) => draft[c.id] ?? c.value, [draft])

  /** 按键名取当前值 —— 依赖判定、跨字段校验、小节摘要都要它 */
  const byKey = React.useMemo(() => {
    const m = new Map<string, ConfigItem>()
    for (const c of all) m.set(c.key, c)
    return m
  }, [all])
  const getValue = React.useCallback(
    (key: string) => {
      const c = byKey.get(key)
      return c ? valueOf(c) : undefined
    },
    [byKey, valueOf]
  )

  const counts = React.useMemo(() => {
    const m: Record<string, number> = {}
    for (const c of all) {
      const id = railIdOf(c)
      // 总开关提到分组头，不算进小节条数
      if (!isGroupSwitch(c.key)) m[id] = (m[id] ?? 0) + 1
      else m[id] = m[id] ?? 0
    }
    return m
  }, [all])

  /**
   * 默认落在**条目最多**的分类，不是左栏第一项。
   * 左栏第一项是「登录策略」，而它只有 1 条 —— 一进页面看到一片空白，
   * 像是没加载出来。
   */
  const firstGroup = React.useMemo(() => {
    const withData = Object.entries(counts).filter(([, n]) => n > 0)
    if (!withData.length) return 'other'
    return withData.sort((a, b) => b[1] - a[1])[0]![0]
  }, [counts])
  const group = search.group && counts[search.group] !== undefined ? search.group : firstGroup

  // ── 校验 ───────────────────────────────────────────────────────────────────
  //
  // 两类错误分开算，规则不同：
  //   单项错（validateOne）只对**动过的**键报 —— 否则库里本来就有的脏数据
  //     （比如别人用 Swagger 写进去的 'abc'）一进页面就满屏红
  //   跨字段错（validateCross）**始终**报，而且要报在**双方**行上 ——
  //     只改了「最小长度」时，冲突的另一半在「最大长度」那一行，
  //     不标出来人根本找不到问题在哪
  //
  // 合并时**单项错优先**：填 999 既超上限又大于最大长度，
  // 该先告诉人「不能大于 128」，而不是「不能大于最大长度（32）」。
  const fieldErrors = React.useMemo(() => {
    const errs: Record<string, string> = {}
    for (const c of all) {
      if (draft[c.id] === undefined) continue
      const e = validateOne(c, draft[c.id]!)
      if (e) errs[c.key] = e
    }
    return errs
  }, [all, draft])

  const crossErrors = React.useMemo(() => validateCross(getValue), [getValue])

  const errors = React.useMemo(
    () => ({ ...crossErrors, ...fieldErrors }),
    [crossErrors, fieldErrors]
  )

  const dirty = React.useMemo(
    () => all.filter((c) => draft[c.id] !== undefined && draft[c.id] !== c.value),
    [all, draft]
  )
  const dirtyGroups = React.useMemo(() => new Set(dirty.map(railIdOf)), [dirty])
  const disabledGroups = React.useMemo(() => {
    const s = new Set<string>()
    for (const c of all) if (isGroupSwitch(c.key) && valueOf(c) === '0') s.add(railIdOf(c))
    return s
  }, [all, valueOf])
  /** 拦保存的错：只算**动过的**键。库里既有的冲突会提示但不挡着人存别的改动 */
  const blocking = React.useMemo(
    () => Object.keys(errors).filter((k) => {
      const c = byKey.get(k)
      return c !== undefined && draft[c.id] !== undefined
    }),
    [errors, byKey, draft]
  )
  const dangerDirty = dirty.filter((c) => metaOf(c.key)?.danger || isGroupSwitch(c.key))

  // ── 当前分类的内容 ─────────────────────────────────────────────────────────
  const kw = (search.q ?? '').trim().toLowerCase()
  const searching = kw.length > 0

  const inScope = React.useMemo(
    () => (searching ? all : all.filter((c) => railIdOf(c) === group)),
    [all, group, searching]
  )

  const matched = React.useMemo(() => {
    if (!searching) return inScope
    return inScope.filter((c) => {
      const meta = metaOf(c.key)
      return (
        c.key.toLowerCase().includes(kw) ||
        c.name.toLowerCase().includes(kw) ||
        (meta?.label ?? '').toLowerCase().includes(kw) ||
        (meta?.hint ?? c.remark ?? '').toLowerCase().includes(kw)
      )
    })
  }, [inScope, searching, kw])

  const groupSwitch = React.useMemo(
    () => (searching ? null : (inScope.find((c) => isGroupSwitch(c.key)) ?? null)),
    [inScope, searching]
  )

  /** 分小节 + 排序。注册表给了 section/order 才不会退化成键名字母序 */
  const sections = React.useMemo(() => {
    const map = new Map<string, ConfigItem[]>()
    for (const c of matched) {
      if (isGroupSwitch(c.key) && !searching) continue
      const s = metaOf(c.key)?.section ?? UNMANAGED_SECTION
      const list = map.get(s) ?? []
      list.push(c)
      map.set(s, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const oa = metaOf(a.key)?.order ?? 999
        const ob = metaOf(b.key)?.order ?? 999
        return oa - ob || a.key.localeCompare(b.key)
      })
    }
    // 小节顺序走注册表，不跟着数据库行顺序
    return [...map.entries()].sort(([a], [b]) => sectionRank(a) - sectionRank(b))
  }, [matched, searching])

  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ConfigItem | null>(null)
  const [saveOpen, setSaveOpen] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<ConfigItem | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const save = useSaveConfigs()
  const del = useDeleteConfigs()

  const groupOff = groupSwitch !== null && valueOf(groupSwitch) === '0'
  const desc = navDesc(group)

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <PageHeader title={t("参数配置")} description={t("系统级动态参数。登录与口令策略是活的 —— 改完立刻对所有人生效。")} />

      {/* ── 顶部粘性栏 ── */}
      <div
        className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur"
        data-testid="config-topbar"
      >
        <InputGroup className="h-9 w-full sm:w-72">
          <InputGroupAddon align="inline-start">
            <IconSearch className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            value={localQ}
            data-testid="filter-q"
            placeholder={t("搜索设置名称或键名…")}
            onChange={(e) => setLocalQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && patch({ q: localQ || undefined })}
            onBlur={() => localQ !== (search.q ?? '') && patch({ q: localQ || undefined })}
          />
        </InputGroup>

        <div className="ms-auto flex items-center gap-2">
          {dirty.length > 0 && (
            <span
              className={cn(
                'text-sm',
                blocking.length ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'
              )}
              data-testid="dirty-count"
            >
              {blocking.length ? t('{{n}} 项填写有误', { n: blocking.length }) : t('{{n}} 项未保存', { n: dirty.length })}
            </span>
          )}
          <Can perm="sys:config:add">
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              data-testid="add-config"
              onClick={() => {
                setEditing(null)
                setSheetOpen(true)
              }}
            >
              <IconPlus className="size-4" />
              {t('新增键')}
            </Button>
          </Can>
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            disabled={dirty.length === 0}
            data-testid="discard-draft"
            onClick={() => setDraft({})}
          >
            <IconRestore className="size-4" />
            {t('放弃')}
          </Button>
          <Can perm="sys:config:edit">
            <Button
              size="sm"
              className="h-9"
              data-testid="save-draft"
              disabled={dirty.length === 0 || blocking.length > 0 || save.isPending}
              onClick={() => {
                setErr(null)
                setSaveOpen(true)
              }}
            >
              {dirty.length > 0 ? t('保存 {{n}} 项', { n: dirty.length }) : t('保存')}
            </Button>
          </Can>
        </div>
      </div>

      {err && <p className="px-1 pt-3 text-sm text-destructive" data-testid="save-error">{err}</p>}

      {/* ── 左右主体 ── */}
      <div className="flex flex-1 flex-col gap-6 py-5 md:flex-row md:gap-8">
        <aside className="md:sticky md:top-20 md:h-fit md:w-52 md:shrink-0">
          {isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : (
            <ConfigNav
              active={group}
              counts={counts}
              dirtyIds={dirtyGroups}
              disabledIds={disabledGroups}
              onSelect={(id) => patch({ group: id, q: undefined })}
            />
          )}
        </aside>

        {/* max-w-4xl：设置屏不该铺满宽屏 —— 标签与控件隔一千多像素，
            眼睛要横扫一整屏才能把两者对起来 */}
        <section className="@container/panel min-w-0 flex-1 md:max-w-4xl" data-testid="config-panel">
          {isPending && (
            <div className="flex flex-col gap-3" data-testid="config-skeleton">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          )}

          {!isPending && searching && (
            <p className="pb-3 text-sm text-muted-foreground" data-testid="search-scope">
              {t('全部分类中匹配「{{q}}」的 {{n}} 项', { q: search.q, n: matched.length })}
            </p>
          )}

          {/* 分类头：图标 + 标题 + 说明 + 组总开关。
              图标徽标和下面每个小节、以及个人中心 Block 同一套视觉——
              一屏扫下来「这是哪个分类」不用读字 */}
          {!isPending && !searching && (
            <div className="flex flex-col gap-3 pb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid size-7 shrink-0 place-content-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
                    {railIcon(group)}
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 className="text-base font-semibold" data-testid="panel-title">
                      {t(railItem(group)?.label ?? group)}
                    </h2>
                    {desc && <p className="text-xs text-muted-foreground">{t(desc)}</p>}
                  </div>
                </div>
                {groupSwitch && (
                  <div className="flex shrink-0 items-center gap-2.5 rounded-md border border-border px-3 py-2">
                    <div className="flex flex-col items-end">
                      <span className="text-xs font-medium">{t('本组配置生效')}</span>
                      <code className="text-2xs text-muted-foreground">{groupSwitch.key}</code>
                    </div>
                    <Switch
                      checked={valueOf(groupSwitch) === '1'}
                      data-testid={`v-${groupSwitch.key}`}
                      onCheckedChange={(c) =>
                        setDraft((d) => ({ ...d, [groupSwitch.id]: c ? '1' : '0' }))
                      }
                      className={cn(
                        valueOf(groupSwitch) !== groupSwitch.value &&
                          'ring-2 ring-amber-500/40 ring-offset-2 ring-offset-background'
                      )}
                    />
                  </div>
                )}
              </div>
              {groupOff && (
                <div
                  className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 ring-1 ring-amber-500/25"
                  data-testid="group-off-banner"
                >
                  <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                    <Trans
                      t={t}
                      i18nKey="这一组的总开关是关的 —— 后端整组不加载，下面的值改了也不会生效，实际用的是 <c>.env</c> 里的默认值。"
                      components={{ c: <code /> }}
                    />
                  </p>
                </div>
              )}
            </div>
          )}

          {!isPending && sections.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground" data-testid="panel-empty">
              {searching ? t('没有匹配的设置项') : t('这一类还没有参数')}
            </p>
          )}

          {/* 小节：图标徽标 + 标题，和个人中心 Block 同一套版式 ——
              不套卡片框，块与块的分隔交给一根 border-b。原来每个小节自己是一张
              `rounded-lg border` 卡片、标题栏还带 `bg-muted/30` 底色，
              一屏堆 5～6 个小节看着比个人中心「重」不少，而这里并不需要
              这层框：内容列已经封顶 max-w-4xl、左边还有条导航，
              「这一块到哪为止」本来就看得出来 */}
          <div className={cn('flex flex-col gap-5', groupOff && 'opacity-60')}>
            {sections.map(([title, items]) => {
              const summary = sectionSummary(title, getValue)
              return (
                <section
                  key={title}
                  className="flex flex-col gap-3 border-b border-border/60 pb-5 last:border-0 last:pb-0"
                  data-testid={`section-${title}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 grid size-7 shrink-0 place-content-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
                        {sectionIcon(title)}
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <h3 className="text-sm font-semibold">{t(title)}</h3>
                        {/* 参照产品在控件右上角回显当前值；策略型参数单个值回显没意义，
                            组合起来的**效果**才是人要确认的 */}
                        {summary && (
                          <p className="text-xs leading-relaxed text-muted-foreground" data-testid={`summary-${title}`}>
                            {summary}
                          </p>
                        )}
                      </div>
                    </div>
                    {title === UNMANAGED_SECTION && (
                      <StatusPill tone="muted">{t('控件按值推断')}</StatusPill>
                    )}
                  </div>
                  {/* 内容缩进到和标题文字对齐（图标 28px + gap 10px = 2.375rem），
                      和个人中心 Block 同一条规则 —— 窄屏不缩进，那时是可用宽度 */}
                  <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 sm:ms-[2.375rem]">
                    {items.map((c) => (
                      <SettingRow
                        key={c.id}
                        item={c}
                        value={valueOf(c)}
                        error={errors[c.key]}
                        disabledReason={groupOff ? null : (metaOf(c.key)?.disabledBy?.(
                          (k) => getValue(k) ?? ''
                        ) ?? null)}
                        onChange={(v) => setDraft((d) => ({ ...d, [c.id]: v }))}
                        onEdit={(x) => {
                          setEditing(x)
                          setSheetOpen(true)
                        }}
                        onDelete={setPendingDelete}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </section>
      </div>

      <ConfigSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />

      <ConfirmDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title={t('保存 {{n}} 项参数', { n: dirty.length })}
        confirmText={t("确认保存")}
        destructive={dangerDirty.length > 0}
        pending={save.isPending}
        description={
          <>
            {t('改动会立刻生效（后端在登录 / 验证码 / 改密码路径上实时读这张表）。')}
            {dangerDirty.length > 0 && (
              <span className="mt-2 block text-destructive">
                {t('其中 {{n}} 项会影响登录或口令安全策略：', { n: dangerDirty.length })}
                {dangerDirty.map((c) => (
                  <span key={c.id} className="mt-1 block font-mono text-xs">
                    {t(metaOf(c.key)?.label ?? c.name)}：{c.value} →{' '}
                    {isSecret(c.key) ? t('（已隐藏）') : draft[c.id]}
                  </span>
                ))}
              </span>
            )}
          </>
        }
        onConfirm={async () => {
          try {
            await save.mutateAsync(dirty.map((c) => ({ id: c.id, body: toBody(c, draft[c.id]!) })))
            setDraft({})
            setSaveOpen(false)
          } catch (e) {
            setErr(e instanceof Error ? e.message : t('保存失败'))
            setSaveOpen(false)
          }
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("删除参数")}
        destructive
        confirmText={t("确认删除")}
        pending={del.isPending}
        description={
          pendingDelete && (
            <>
              <Trans
                t={t}
                i18nKey="将删除 <c>{{key}}</c>。删掉后后端会回落到 <c>.env</c> 里的默认值 —— 业务代码里引用过的键请先确认没人读。"
                values={{ key: pendingDelete.key }}
                components={{ c: <code /> }}
              />
            </>
          )
        }
        onConfirm={async () => {
          if (!pendingDelete) return
          try {
            await del.mutateAsync([pendingDelete.id])
            setPendingDelete(null)
          } catch (e) {
            setErr(e instanceof Error ? e.message : t('删除失败'))
            setPendingDelete(null)
          }
        }}
      />
    </div>
  )
}
