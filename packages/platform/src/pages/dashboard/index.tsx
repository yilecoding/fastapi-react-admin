import * as React from 'react'
import { currentLanguage, formatTime, getDisplayTimeZone } from '@admin/i18n'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconAdjustmentsHorizontal, IconShieldLock } from '@tabler/icons-react'

import { Alert } from '@admin/ui/components/alert'
import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast } from '@admin/ui/components/toast'
import { cn } from '@admin/ui/lib/utils'

import { codesQuery, meQuery, sidebarQuery } from '../../auth/queries'
import { usePerm } from '../../auth/use-perm'
import { useSaveUserPreference, userPreferenceQuery } from '../../auth/user-preferences'
import { usePlatform } from '../../shell/platform-context'
import { useSidebar } from '../../shell/use-sidebar'
import { PageHeader } from '../../shell/page-header'
import { RefreshButton } from '../_shared/filters'
import { invalidateInbox } from '../notification/api'
import { NoticeReaderSheet } from '../notice/reader-sheet'
import { InstanceSheet } from '../workflow/instance-sheet'
import { workflowKeys } from '../workflow/api'
import { attentionQuery, dashKeys, deskTodoQuery, servicesQuery, visitsQuery } from './api'
import { flattenPages } from './cards/quick-links'
import { DASHBOARD_CARDS } from './cards/registry'
import type { CardContext, CardProps, DashboardCardDef, TodoTab } from './cards/types'
import { DashboardEditor } from './editor'
import {
  LAYOUT_PREF_KEY,
  defaultLayout,
  resolveLayout,
  sameLayout,
  toStoredLayout,
  type CardWidth,
  type DashboardLayout,
  type LayoutItem,
} from './layout'

export type DashboardSearch = {
  /** 公告卡 / 消息卡里就地打开的那一条公告（雪花 ID，字符串） */
  notice?: string
  /** 待办 / 我发起的里就地打开的那张审批单（雪花 ID，字符串） */
  wf?: string
  /** 编辑工作台（硬纪律 2：刷新之后还在编辑模式） */
  edit?: boolean
  /** 「待我处理」的分段；不写 = 全部 */
  todo?: Exclude<TodoTab, 'all'>
}

/**
 * 卡片宽度 → 12 列网格里占几列（`layout.ts` 的 `CardWidth`）。按**容器**宽度断（`@container/main`），不按视口：
 * 侧边栏收起 / 展开时内容区宽度差两百多像素。窄的时候三分之一 / 一半占半行、三分之二占整行，再窄一律整行
 *
 * 类名要写成完整的字面量：Tailwind 只扫源码里出现过的整串
 */
const SPAN: Record<CardWidth, string> = {
  third: 'col-span-12 @2xl/main:col-span-6 @5xl/main:col-span-4',
  half: 'col-span-12 @2xl/main:col-span-6',
  'two-thirds': 'col-span-12 @5xl/main:col-span-8',
  full: 'col-span-12',
}

/**
 * 工作台（平台首页），每个人自己的（#202）。
 *
 * - 卡片是**注册表**（`cards/registry.ts`）：每张卡片声明自己要什么权限，没权限的不进候选也不渲染
 * - 两组：每个人的（待办 / 发起 / 消息 / 入口）在上；「系统运行」区在下，有对应管理权限的人才有
 * - 布局按人存在服务端（个人偏好 `dashboard.layout`），换设备 / 从网页换到桌面端都一样；没存过就按权限算默认布局
 * - 编辑模式进 URL（`edit`），草稿只在这一页的 state 里，「保存」才写服务端
 *
 * 硬纪律 1：组件 router-独立 —— 这里只用 `<Link>`（走 router context 而非 match context，隐藏 tab 里照样可用），
 * 开抽屉 / 切分段 / 进出编辑模式一律经 `onSearchChange` 写自己的 search。
 */
export function DashboardPage({
  search = {},
  onSearchChange,
}: {
  search?: DashboardSearch
  onSearchChange?: (next: DashboardSearch) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const me = useQuery(meQuery)
  const codes = useQuery(codesQuery)
  const sidebarQ = useQuery(sidebarQuery)
  const { can, canAny, isSuperuser } = usePerm()
  const { isValidPath } = usePlatform()
  const sidebarOpts = React.useMemo(() => ({ isValidPath }), [isValidPath])
  const sidebar = useSidebar(sidebarOpts)
  const pref = useQuery(userPreferenceQuery(LAYOUT_PREF_KEY))
  const save = useSaveUserPreference(LAYOUT_PREF_KEY)

  const patch = (p: Partial<DashboardSearch>) => onSearchChange?.({ ...search, ...p })
  const systemTitleId = React.useId()

  // ── 这个人能用哪些卡片 ──
  // 🔴 权限码 / 「我是谁」/ 侧边栏**有数据**之前不算：`usePerm().can` 在 codes 还没回来时恒为 false，
  // 那时算出来的「默认布局」只有人人都有的那几张，等 codes 回来又多出系统运行区 —— 页面先画一版再跳一版。
  // 三者一律只看 `.data`，不看 `.error`：后台重取失败时 React Query 保留上一次的数据、同时置上 error ——
  // 看 error 的话，侧边栏一次重取失败，整个工作台（连同正在编辑的编辑器）就没了
  const pages = React.useMemo(() => flattenPages(sidebar.nav), [sidebar.nav])
  const ctxReady = Boolean(me.data && codes.data && sidebarQ.data)
  const available = React.useMemo<DashboardCardDef[]>(() => {
    if (!ctxReady) return []
    const inSidebar = new Set(pages.map((p) => p.path))
    // 权限判定直接用 `usePerm` 那一份，不在这里另写一遍（两份迟早漂移）
    const ctx: CardContext = { can, canAny, isSuperuser, inSidebar: (path) => inSidebar.has(path) }
    return DASHBOARD_CARDS.filter((c) => c.available(ctx))
  }, [ctxReady, can, canAny, isSuperuser, pages])
  const byId = React.useMemo(() => new Map(available.map((c) => [c.id, c])), [available])
  const titleOf = React.useCallback((id: string) => byId.get(id)?.title(t) ?? id, [byId, t])
  const groupOf = React.useCallback((id: string) => byId.get(id)?.group ?? 'work', [byId])

  // ── 布局：存的那份 + 现在能用的卡片 ──
  // 能用的卡片还没算出来时（`ctxReady` 之前 `available` 是空的）不合并 —— 拿空集合并出来的是「一张卡片都没有」，
  // 会先闪一下「所有卡片都隐藏了」
  const resolved = React.useMemo(
    () => (pref.data && ctxReady ? resolveLayout(pref.data.value, available) : null),
    [pref.data, ctxReady, available]
  )
  /**
   * 🔴 读失败时显示默认布局，但**页面上要说出来**、而且不让编辑（硬纪律 9）：
   * 静默退回默认 = 让人以为「我存的布局没了」；而这时允许编辑保存，会拿默认布局覆盖掉他服务端那份
   */
  const baseline: DashboardLayout | null =
    resolved?.layout ?? (pref.error && ctxReady ? defaultLayout(available) : null)
  const canEdit = Boolean(resolved)
  const editing = Boolean(search.edit) && canEdit
  const [draft, setDraft] = React.useState<DashboardLayout | null>(null)
  // 草稿写成 `draft ?? baseline` 两层：后台重取回来不会冲掉还没保存的改动
  const shown = editing ? (draft ?? baseline) : baseline
  const dirty = Boolean(editing && draft && baseline && !sameLayout(draft, baseline))

  const enterEdit = () => {
    if (!canEdit) return
    setDraft(null)
    save.reset()
    patch({ edit: true })
  }
  const leaveEdit = () => {
    setDraft(null)
    save.reset()
    patch({ edit: undefined })
  }
  const saveLayout = () => {
    if (!shown) return
    save.mutate(toStoredLayout(shown, pref.data?.value ?? null), {
      onSuccess: () => {
        toast.success(t('工作台布局已保存'))
        leaveEdit()
      },
    })
  }

  // 「刷新」：只重取卡片的数据（布局不动）。卡片的查询各自在卡片里，按 key 前缀失效；
  // 收件箱 + 公告读者列表那一组用铃铛同一个 `invalidateInbox`，别在这里抄一份 key 清单
  const [refreshing, setRefreshing] = React.useState(false)
  const refreshAll = () => {
    if (refreshing) return
    setRefreshing(true)
    void Promise.all([
      invalidateInbox(qc),
      qc.invalidateQueries({ queryKey: dashKeys.all }),
      qc.invalidateQueries({ queryKey: workflowKeys.all }),
    ]).finally(() => setRefreshing(false))
  }

  const cardProps: CardProps = {
    openNotice: (id) => patch({ notice: id }),
    openApproval: (id) => patch({ wf: id }),
    todoTab: search.todo ?? 'all',
    onTodoTab: (tab) => patch({ todo: tab === 'all' ? undefined : tab }),
    onCustomize: enterEdit,
    editing,
    quickLinks: shown?.quickLinks ?? null,
    pages,
  }

  // 只在「还没有数据」时算失败（有上一次的数据就照常用，同上面 `ctxReady` 的判据）
  const contextError =
    (!me.data && me.error) || (!codes.data && codes.error) || (!sidebarQ.data && sidebarQ.error) || null
  const visible = shown?.items.filter((i) => i.visible) ?? []
  const workItems = visible.filter((i) => groupOf(i.id) === 'work')
  const systemItems = visible.filter((i) => groupOf(i.id) === 'system')

  const renderGrid = (items: LayoutItem[], testId: string) => (
    <div className="grid grid-cols-12 gap-5" data-testid={testId}>
      {items.map((item) => {
        const def = byId.get(item.id)
        if (!def) return null
        return (
          <div key={item.id} className={cn('min-w-0', SPAN[item.width])} data-testid={`dash-card-${item.id}`} data-width={item.width}>
            <def.Component {...cardProps} />
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-1 flex-col gap-5 py-4 md:py-6">
          <PageHeader title={t('仪表盘')} description={t('平台首页：每个人自己的工作台。')} />

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground" data-testid="dash-greeting">
                {todayLine()}
                {me.data && <> · {greeting(me.data.nickname, t)}</>}
              </span>
              <Headline enabled={ctxReady && byId.has('todo')} ready={ctxReady} />
            </div>
            {!editing && (
              <div className="flex items-center gap-2">
                <RefreshButton onClick={refreshAll} busy={refreshing} testId="dash-refresh" />
                <Button variant="outline" size="sm" data-testid="dash-edit" disabled={!canEdit} onClick={enterEdit}>
                  <IconAdjustmentsHorizontal className="size-4" />
                  {t('自定义')}
                </Button>
              </div>
            )}
          </div>

          {Boolean(contextError) && (
            <QueryError
              error={contextError}
              onRetry={() => {
                void me.refetch()
                void codes.refetch()
                void sidebarQ.refetch()
              }}
              testId="dash-context-error"
            />
          )}

          {/* 只在「一份都没读到」时说「先按默认布局显示」：读到过之后一次后台重取失败，屏幕上仍是他自己的布局、也能编辑 */}
          {Boolean(pref.error) && !pref.data && (
            <QueryError
              error={pref.error}
              title={t('没能读取你保存的工作台布局')}
              detail={t('下面先按默认布局显示；重试成功后会换成你自己的布局。读取成功之前不能编辑。')}
              onRetry={() => void pref.refetch()}
              testId="dash-layout-error"
            />
          )}

          {resolved?.unreadable && !editing && (
            <Alert tone="warning" data-testid="dash-layout-unreadable">
              {t('保存的工作台布局格式认不出来，下面是默认布局。编辑并保存一次就会覆盖它。')}
            </Alert>
          )}

          {editing && shown && (
            <DashboardEditor
              layout={shown}
              titleOf={titleOf}
              groupOf={groupOf}
              pages={pages}
              canSave={dirty || Boolean(resolved?.unreadable)}
              saving={save.isPending}
              saveError={save.error}
              onChange={setDraft}
              onReset={() => setDraft(defaultLayout(available))}
              onCancel={leaveEdit}
              onSave={saveLayout}
            />
          )}

          {!shown ? (
            !contextError && <GridSkeleton />
          ) : visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground" data-testid="dash-empty">
              {t('所有卡片都隐藏了。点「自定义」把需要的卡片打开。')}
            </p>
          ) : (
            <>
              {workItems.length > 0 && renderGrid(workItems, 'dash-grid')}
              {systemItems.length > 0 && (
                <section className="mt-1 flex flex-col gap-5" data-testid="dash-system" aria-labelledby={systemTitleId}>
                  <SystemHeader items={systemItems} titleId={systemTitleId} />
                  {renderGrid(systemItems, 'dash-grid-system')}
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {/* 开在 URL 上 → 抽屉 portal 挂进本 tab 的根节点（reader-sheet / instance-sheet 的注释） */}
      <NoticeReaderSheet
        noticeId={search.notice ?? null}
        onOpenChange={(o) => {
          if (!o) patch({ notice: undefined })
        }}
      />
      <InstanceSheet id={search.wf ?? null} onClose={() => patch({ wf: undefined })} />
    </div>
  )
}

type TFn = (key: string, vars?: Record<string, unknown>) => string

/** 「10月31日星期六」—— 按**显示时区**取今天（不是浏览器时区），格式跟界面语言 */
function todayLine(): string {
  return new Date().toLocaleDateString(currentLanguage(), {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: getDisplayTimeZone(),
  })
}

/** 「下午好，孙强」—— 时段按显示时区算。整句一个 key（英文的逗号、语序和中文不一样） */
function greeting(name: string, t: TFn): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: getDisplayTimeZone() }).format(new Date())
  )
  if (hour < 5) return t('夜深了，{{name}}', { name })
  if (hour < 11) return t('上午好，{{name}}', { name })
  if (hour < 13) return t('中午好，{{name}}', { name })
  if (hour < 18) return t('下午好，{{name}}', { name })
  return t('晚上好，{{name}}', { name })
}

/**
 * 大标题那句话：「你有 N 件事等着处理，其中 M 件加急」。
 *
 * 数字和「待我处理」卡片同一份 query（`deskTodoQuery`），不另取。N = 待审批 + 退回给我（不含草稿，同卡片的「全部」）。
 * 取数失败时**说出来**（硬纪律 9）—— 不能退成「手上没有要处理的事」，那是一句假话
 */
function Headline({ enabled, ready }: { enabled: boolean; ready: boolean }) {
  const { t } = useTranslation()
  const todo = useQuery({ ...deskTodoQuery, enabled })
  const cls = 'text-[26px] leading-tight font-extrabold tracking-tight'

  if (!ready || (enabled && todo.isPending)) return <Skeleton className="h-8 w-80 max-w-full" />
  if (!enabled) return <p className={cls} data-testid="dash-headline">{t('欢迎回来')}</p>
  if (!todo.data) {
    return (
      <p className={cn(cls, 'text-muted-foreground')} data-testid="dash-headline" data-state="error">
        {t('待办数量没取到')}
      </p>
    )
  }
  const n = todo.data.total
  const m = todo.data.items.filter((r) => r.urgent).length
  return (
    <p className={cls} data-testid="dash-headline" data-total={n} data-urgent={m}>
      {n === 0 ? (
        t('手上没有要处理的事')
      ) : m === 0 ? (
        <Trans t={t} i18nKey="你有 <hl>{{n}} 件事</hl>等着处理" values={{ n }} components={{ hl: <span className="text-primary" /> }} />
      ) : (
        <Trans
          t={t}
          i18nKey="你有 <hl>{{n}} 件事</hl>等着处理，其中 <warn>{{m}} 件加急</warn>"
          values={{ n, m }}
          components={{ hl: <span className="text-primary" />, warn: <span className="text-orange-700 dark:text-orange-400" /> }}
        />
      )}
    </p>
  )
}

/**
 * 「系统运行」那一行：标题 · 「仅管理员可见」· 最近一次取到数据的时刻。
 *
 * 时刻读的是这一区卡片自己那几份 query 的 `dataUpdatedAt`（`enabled: false` 只观察缓存、不多发请求）——
 * 不另记一个「页面打开时间」：点了刷新、或者某张卡片自己重试成功，这个时刻要跟着变
 */
function SystemHeader({ items, titleId }: { items: LayoutItem[]; titleId: string }) {
  const { t } = useTranslation()
  const ids = new Set(items.map((i) => i.id))
  const attention = useQuery({ ...attentionQuery, enabled: false })
  const services = useQuery({ ...servicesQuery, enabled: false })
  const visits = useQuery({ ...visitsQuery(), enabled: false })
  const at = Math.max(
    ids.has('attention') ? attention.dataUpdatedAt : 0,
    ids.has('services') ? services.dataUpdatedAt : 0,
    ids.has('visits') ? visits.dataUpdatedAt : 0
  )
  return (
    <div className="flex items-center gap-3">
      <h2 id={titleId} className="text-lg font-extrabold">
        {t('系统运行')}
      </h2>
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        <IconShieldLock className="size-3" aria-hidden />
        {t('仅管理员可见')}
      </span>
      <span className="h-px flex-1 bg-border" />
      {at > 0 && (
        <span className="text-xs text-muted-foreground" data-testid="dash-system-updated">
          {t('{{at}} 更新', { at: formatTime(at) })}
        </span>
      )}
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-5" data-testid="dash-loading">
      <Skeleton className={cn('h-80', SPAN['two-thirds'])} />
      <Skeleton className={cn('h-80', SPAN.third)} />
      <Skeleton className={cn('h-40', SPAN.third)} />
      <Skeleton className={cn('h-40', SPAN.third)} />
      <Skeleton className={cn('h-40', SPAN.third)} />
    </div>
  )
}
