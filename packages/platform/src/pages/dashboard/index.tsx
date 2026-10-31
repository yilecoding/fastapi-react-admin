import * as React from 'react'
import { formatDateTime } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconLayoutDashboard, IconLoader2, IconRefresh } from '@tabler/icons-react'

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
import { invalidateInbox } from '../notification/api'
import { NoticeReaderSheet } from '../notice/reader-sheet'
import { InstanceSheet } from '../workflow/instance-sheet'
import { workflowKeys } from '../workflow/api'
import { dashKeys } from './api'
import { flattenPages } from './cards/quick-links'
import { DASHBOARD_CARDS } from './cards/registry'
import type { CardContext, CardProps, DashboardCardDef } from './cards/types'
import { DashboardEditor } from './editor'
import {
  LAYOUT_PREF_KEY,
  defaultLayout,
  resolveLayout,
  sameLayout,
  toStoredLayout,
  type DashboardLayout,
} from './layout'

export type DashboardSearch = {
  /** 公告卡 / 未读消息卡里就地打开的那一条公告（雪花 ID，字符串） */
  notice?: string
  /** 待办卡里就地打开的那张审批单（雪花 ID，字符串） */
  wf?: string
  /** 编辑工作台（硬纪律 2：刷新之后还在编辑模式） */
  edit?: boolean
}

/**
 * 工作台（平台首页），每个人自己的（#202）。
 *
 * - 卡片是**注册表**（`cards/registry.ts`）：每张卡片声明自己要什么权限，没权限的不进候选也不渲染
 * - 布局按人存在服务端（个人偏好 `dashboard.layout`），换设备 / 从网页换到桌面端都一样；没存过就按权限算默认布局
 * - 编辑模式进 URL（`edit`），草稿只在这一页的 state 里，「保存」才写服务端
 *
 * 硬纪律 1：组件 router-独立 —— 这里只用 `<Link>`（走 router context 而非 match context，隐藏 tab 里照样可用），
 * 开抽屉 / 进出编辑模式一律经 `onSearchChange` 写自己的 search。
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
  const { can, canAny } = usePerm()
  const { isValidPath } = usePlatform()
  const sidebarOpts = React.useMemo(() => ({ isValidPath }), [isValidPath])
  const sidebar = useSidebar(sidebarOpts)
  const pref = useQuery(userPreferenceQuery(LAYOUT_PREF_KEY))
  const save = useSaveUserPreference(LAYOUT_PREF_KEY)

  const patch = (p: Partial<DashboardSearch>) => onSearchChange?.({ ...search, ...p })

  // ── 这个人能用哪些卡片 ──
  // 🔴 权限码 / 「我是谁」/ 侧边栏**有数据**之前不算：`usePerm().can` 在 codes 还没回来时恒为 false，
  // 那时算出来的「默认布局」只有人人都有的那几张，等 codes 回来又多出统计卡 —— 页面先画一版再跳一版。
  // 三者一律只看 `.data`，不看 `.error`：后台重取失败时 React Query 保留上一次的数据、同时置上 error ——
  // 看 error 的话，侧边栏一次重取失败，整个工作台（连同正在编辑的编辑器）就没了
  const pages = React.useMemo(() => flattenPages(sidebar.nav), [sidebar.nav])
  const ctxReady = Boolean(me.data && codes.data && sidebarQ.data)
  const available = React.useMemo<DashboardCardDef[]>(() => {
    if (!ctxReady) return []
    const inSidebar = new Set(pages.map((p) => p.path))
    // 权限判定直接用 `usePerm` 那一份，不在这里另写一遍（两份迟早漂移）
    const ctx: CardContext = { can, canAny, inSidebar: (path) => inSidebar.has(path) }
    return DASHBOARD_CARDS.filter((c) => c.available(ctx))
  }, [ctxReady, can, canAny, pages])
  const byId = React.useMemo(() => new Map(available.map((c) => [c.id, c])), [available])
  const titleOf = React.useCallback((id: string) => byId.get(id)?.title(t) ?? id, [byId, t])

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

  // 「刷新」：只重取卡片的数据（布局不动）。卡片的查询各自在卡片里，按 key 失效；
  // 收件箱 + 公告读者列表那一组用铃铛同一个 `invalidateInbox`，别在这里抄一份 key 清单
  const [refreshing, setRefreshing] = React.useState(false)
  const refreshAll = () => {
    setRefreshing(true)
    void Promise.all([
      invalidateInbox(qc),
      qc.invalidateQueries({ queryKey: dashKeys.all }),
      qc.invalidateQueries({ queryKey: workflowKeys.counts() }),
      qc.invalidateQueries({ queryKey: workflowKeys.inbox() }),
    ]).finally(() => setRefreshing(false))
  }

  const cardProps: CardProps = {
    openNotice: (id) => patch({ notice: id }),
    openApproval: (id) => patch({ wf: id }),
    quickLinks: shown?.quickLinks ?? null,
    pages,
  }

  // 只在「还没有数据」时算失败（有上一次的数据就照常用，同上面 `ctxReady` 的判据）
  const contextError =
    (!me.data && me.error) || (!codes.data && codes.error) || (!sidebarQ.data && sidebarQ.error) || null
  const visibleItems = shown?.items.filter((i) => i.visible) ?? []

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader title={t('仪表盘')} description={t('平台首页：每个人自己的工作台。')} />

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-lg font-semibold" data-testid="dash-greeting">
                {t('你好，{{name}}', { name: me.data?.nickname ?? '…' })}
              </span>
              <span className="text-sm text-muted-foreground">
                {me.data?.last_login_time
                  ? t('上次登录 {{at}}', { at: formatDateTime(me.data.last_login_time) })
                  : t('欢迎回来')}
                {me.data?.dept ? ` · ${me.data.dept}` : ''}
              </span>
            </div>
            {!editing && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline" size="sm" data-testid="dash-edit"
                  disabled={!canEdit} onClick={enterEdit}
                >
                  <IconLayoutDashboard className="size-4" />
                  {t('编辑工作台')}
                </Button>
                <Button
                  variant="outline" size="sm" data-testid="dash-refresh"
                  disabled={refreshing} onClick={refreshAll}
                >
                  {refreshing ? <IconLoader2 className="size-4 animate-spin" /> : <IconRefresh className="size-4" />}
                  {t('刷新')}
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
          ) : visibleItems.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground" data-testid="dash-empty">
              {t('所有卡片都隐藏了。点「编辑工作台」把需要的卡片打开。')}
            </p>
          ) : (
            <div className="grid gap-4 @4xl/main:grid-cols-2" data-testid="dash-grid">
              {visibleItems.map((item) => {
                const def = byId.get(item.id)
                if (!def) return null
                return (
                  <div
                    key={item.id}
                    className={cn('min-w-0', item.width === 'full' && '@4xl/main:col-span-2')}
                    data-testid={`dash-card-${item.id}`}
                    data-width={item.width}
                  >
                    <def.Component {...cardProps} />
                  </div>
                )
              })}
            </div>
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

function GridSkeleton() {
  return (
    <div className="grid gap-4 @4xl/main:grid-cols-2" data-testid="dash-loading">
      <Skeleton className="h-28 w-full @4xl/main:col-span-2" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
