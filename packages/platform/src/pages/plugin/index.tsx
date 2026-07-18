import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle, IconChevronDown, IconDatabaseExclamation, IconDownload,
  IconLoader2, IconPlus, IconRefresh, IconTrash,
} from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Card, CardContent, CardHeader } from '@admin/ui/components/card'
import { Skeleton } from '@admin/ui/components/skeleton'
import { Switch } from '@admin/ui/components/switch'

import { ApiError } from '../../api-client/errors'
import { ConfirmDialog } from '../../shell/confirm-dialog'
import { PageHeader } from '../../shell/page-header'
import { ResetButton, SelectFilter, TextFilter } from '../_shared/filters'
import { StatusPill } from '../_shared/status'
import {
  declaredPrefixes, downloadPlugin, isEnabled, pluginChangedQuery, pluginKind,
  pluginsQuery, realPrefix, useTogglePlugin, useUninstallPlugin,
  type PluginInfo,
} from './api'
import { InstallSheet } from './install-sheet'

/**
 * 插件管理。
 *
 * 不是列表页：数据来自 Redis 里各插件 `plugin.toml` 的解析结果，
 * 没有分页、没有排序入参、条目很少但每条元数据很厚（描述/设置项/API 前缀），
 * 所以用卡片而不是表格。
 *
 * 硬纪律：组件 router-独立，筛选进 URL。
 */
export type PluginPageSearch = {
  /** 名称/摘要关键字 */
  q?: string
  /** '1' 启用 · '0' 停用 */
  enabled?: string
  /** 标签 */
  tag?: string
}

/** 当前后端跑的数据库。插件 plugin.toml 里的 `database` 声明拿它比对。 */
const CURRENT_DB = 'sqlserver'

const ENABLED_ITEMS: Record<string, string> = { all: '全部状态', '1': '已启用', '0': '已停用' } // 值即 key，SelectFilter 在渲染处翻

export function PluginPage({
  search = {},
  onSearchChange,
}: {
  search?: PluginPageSearch
  onSearchChange?: (next: PluginPageSearch) => void
}) {
  const { t } = useTranslation()
  const { data: plugins = [], isPending, isFetching, refetch } = useQuery(pluginsQuery)
  const { data: changed } = useQuery(pluginChangedQuery)

  const [installOpen, setInstallOpen] = React.useState(false)
  const [pendingUninstall, setPendingUninstall] = React.useState<PluginInfo | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const toggle = useTogglePlugin()
  const uninstall = useUninstallPlugin()

  const patch = (next: Partial<PluginPageSearch>) => onSearchChange?.({ ...search, ...next })

  const tagItems = React.useMemo(() => {
    const tags = new Set<string>()
    // 回调参数不能叫 t —— 会遮蔽翻译函数
    plugins.forEach((p) => p.plugin.tags?.forEach((tag) => tags.add(tag)))
    return { all: '全部标签', ...Object.fromEntries([...tags].sort().map((tag) => [tag, tag])) }
  }, [plugins])

  const filtered = React.useMemo(() => {
    const q = search.q?.trim().toLowerCase()
    return plugins.filter((p) => {
      if (q) {
        const hay = `${p.plugin.name} ${p.plugin.summary} ${p.plugin.description}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (search.enabled !== undefined && p.plugin.enable !== search.enabled) return false
      if (search.tag && !p.plugin.tags?.includes(search.tag)) return false
      return true
    })
  }, [plugins, search.q, search.enabled, search.tag])

  const hasFilter = Boolean(search.q || search.enabled !== undefined || search.tag)
  const clearFilters = () => patch({ q: undefined, enabled: undefined, tag: undefined })

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader title={t("插件管理")} description={t("查看已装插件、启停与打包下载。")} />

          {/* 改动要重启才生效 —— 这件事必须说出来，否则用户以为点完开关就生效了 */}
          {changed && (
            <div
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
              data-testid="plugin-changed-banner"
            >
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <Trans
                  t={t}
                  i18nKey="有插件发生变更，<b>需要重启后端服务才会生效</b>。启停/安装/卸载都只改了 Redis 里的记录，运行中的路由不会热更新。"
                  components={{ b: <strong /> }}
                />
              </span>
            </div>
          )}

          {actionError && (
            <div
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="plugin-action-error"
            >
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {/* 工具栏 */}
          <div className="flex flex-wrap items-center gap-2">
            <TextFilter
              value={search.q ?? ''}
              placeholder={t("搜索插件名 / 描述…")}
              testId="filter-plugin"
              width="w-56"
              onCommit={(v) => patch({ q: v || undefined })}
            />
            <SelectFilter
              value={search.enabled}
              items={ENABLED_ITEMS}
              testId="filter-enabled"
              onChange={(v) => patch({ enabled: v })}
            />
            <SelectFilter
              value={search.tag}
              items={tagItems}
              testId="filter-tag"
              onChange={(v) => patch({ tag: v })}
            />
            {hasFilter && <ResetButton onClick={clearFilters} />}
            <span className="text-sm text-muted-foreground" data-testid="plugin-count">
              {t('共 {{n}} / {{total}} 个', { n: filtered.length, total: plugins.length })}
            </span>
            <div className="ms-auto flex items-center gap-2">
              <Button
                variant="outline" size="sm" data-testid="plugin-refresh"
                disabled={isFetching} onClick={() => void refetch()}
              >
                {isFetching ? <IconLoader2 className="size-4 animate-spin" /> : <IconRefresh className="size-4" />}
                {t('刷新')}
              </Button>
              <Button size="sm" data-testid="install-plugin" onClick={() => setInstallOpen(true)}>
                <IconPlus className="size-4" />
                {t('安装插件')}
              </Button>
            </div>
          </div>

          {isPending ? (
            <div className="grid gap-4 @3xl/main:grid-cols-2">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-52 w-full rounded-lg" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center"
              data-testid="plugin-empty"
            >
              <p className="text-sm text-muted-foreground">
                {plugins.length === 0 ? t('没有已安装的插件') : t('没有匹配的插件')}
              </p>
              {hasFilter && (
                <ResetButton variant="outline" testId="empty-clear-filter" label={t("清除筛选")} onClick={clearFilters} />
              )}
            </div>
          ) : (
            <div className="grid gap-4 @3xl/main:grid-cols-2" data-testid="plugin-grid">
              {filtered.map((p) => (
                <PluginCard
                  key={p.plugin.name}
                  info={p}
                  toggling={toggle.isPending && toggle.variables === p.plugin.name}
                  onToggle={async () => {
                    setActionError(null)
                    try {
                      await toggle.mutateAsync(p.plugin.name)
                    } catch (e) {
                      setActionError(e instanceof ApiError ? e.message : t('状态切换失败'))
                    }
                  }}
                  onDownload={async () => {
                    setActionError(null)
                    try {
                      await downloadPlugin(p.plugin.name)
                    } catch (e) {
                      setActionError(e instanceof ApiError ? e.message : t('下载失败'))
                    }
                  }}
                  onUninstall={() => {
                    setActionError(null)
                    setPendingUninstall(p)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <InstallSheet open={installOpen} onOpenChange={setInstallOpen} />

      <ConfirmDialog
        open={pendingUninstall !== null}
        onOpenChange={(o) => !o && setPendingUninstall(null)}
        title={t("卸载插件")}
        description={
          pendingUninstall
            ? t('确定卸载「{{summary}}（{{name}}）」吗？', { summary: pendingUninstall.plugin.summary, name: pendingUninstall.plugin.name }) +
              t('后端会先把插件目录打包成 backup.zip 再删除，同时卸载它的 Python 依赖。') +
              t('卸载后需要重启服务，并按插件说明移除相关配置。')
            : ''
        }
        confirmText={t("卸载")}
        destructive
        pending={uninstall.isPending}
        onConfirm={async () => {
          if (!pendingUninstall) return
          try {
            await uninstall.mutateAsync(pendingUninstall.plugin.name)
            setPendingUninstall(null)
          } catch (e) {
            // 必需插件 / 非开发环境都会被后端拒绝 —— 把原话显示出来
            setActionError(e instanceof ApiError ? e.message : t('卸载失败'))
            setPendingUninstall(null)
          }
        }}
      />
    </div>
  )
}

/* ────────────────────────── 单个插件卡 ────────────────────────── */

function PluginCard({
  info, toggling, onToggle, onDownload, onUninstall,
}: {
  info: PluginInfo
  toggling: boolean
  onToggle: () => void
  onDownload: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [downloading, setDownloading] = React.useState(false)
  const m = info.plugin
  const on = isEnabled(info)
  const kind = pluginKind(info)
  const prefixes = declaredPrefixes(info)
  const settings = Object.entries(info.settings ?? {})
  // plugin.toml 里声明的 database 不含当前库 —— 这正是本仓库的处境（fork 适配 SQL Server），
  // 不是错误，但要标出来，免得排查问题时以为插件是「官方支持」的
  const dbMismatch = m.database?.length > 0 && !m.database.includes(CURRENT_DB)

  return (
    <Card data-testid={`plugin-card-${m.name}`} data-enabled={on}>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">{m.summary ? t(m.summary) : m.name}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {m.name}
              </code>
              <Badge variant="outline" className="font-normal tabular-nums">v{m.version}</Badge>
              {on ? <StatusPill tone="success">{t('已启用')}</StatusPill> : <StatusPill tone="muted">{t('已停用')}</StatusPill>}
            </div>
            <p className="text-sm text-muted-foreground">{t(m.description)}</p>
          </div>
          <Switch
            checked={on}
            disabled={toggling}
            onCheckedChange={onToggle}
            aria-label={on ? t('停用 {{name}}', { name: m.name }) : t('启用 {{name}}', { name: m.name })}
            data-testid={`plugin-toggle-${m.name}`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {m.tags?.map((tag) => (
            <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>
          ))}
          <Badge variant="outline" className="font-normal" title={kind.hint}>{kind.label}</Badge>
          <span className="text-xs text-muted-foreground">by {m.author}</span>
        </div>

        {dbMismatch && (
          <p
            className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
            data-testid={`plugin-db-warn-${m.name}`}
          >
            <IconDatabaseExclamation className="mt-0.5 size-3.5 shrink-0" />
            {t('插件声明支持 {{dbs}}，当前库是 {{cur}} —— 本仓库是适配分叉，功能已实测可用，但上游不保证。', { dbs: m.database.join(' / '), cur: CURRENT_DB })}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline" size="sm" disabled={downloading}
            data-testid={`plugin-download-${m.name}`}
            onClick={async () => {
              setDownloading(true)
              try { await onDownload() } finally { setDownloading(false) }
            }}
          >
            {downloading ? <IconLoader2 className="size-4 animate-spin" /> : <IconDownload className="size-4" />}
            {t('下载 zip')}
          </Button>
          <Button
            variant="outline" size="sm" data-testid={`plugin-uninstall-${m.name}`}
            className="text-destructive hover:text-destructive"
            onClick={onUninstall}
          >
            <IconTrash className="size-4" />
            {t('卸载')}
          </Button>
          {(prefixes.length > 0 || settings.length > 0) && (
            <Button
              variant="ghost" size="sm" className="ms-auto"
              data-testid={`plugin-more-${m.name}`}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? t('收起') : t('详情（{{n}}）', { n: prefixes.length + settings.length })}
              <IconChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </Button>
          )}
        </div>

        {open && (
          <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/30 p-3"
               data-testid={`plugin-detail-${m.name}`}>
            {prefixes.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('API 前缀')}</span>
                {prefixes.map((pre) => (
                  <div key={pre} className="flex flex-wrap items-baseline gap-2 font-mono text-xs">
                    <span className="text-muted-foreground line-through">{pre}</span>
                    <span aria-hidden>→</span>
                    <span className="text-foreground">{realPrefix(info, pre)}</span>
                  </div>
                ))}
                {info.app?.extend && (
                  // 这个差异坑过一次：照 plugin.toml 写的前缀去调接口会 404
                  <p className="text-xs text-muted-foreground">
                    {/* 整句一个 key —— 拆成「前半 + <code> + 后半」的话，
                        英文语序变了就没法重排（i18next 的 Trans 正是为这个存在的） */}
                    <Trans
                      t={t}
                      i18nKey="该插件 extend 到 <code>{{app}}</code>，实际挂载路径会带上宿主应用的段，<b>不是 toml 里写的那个</b>。"
                      values={{ app: info.app.extend }}
                      components={{ code: <code className="font-mono" />, b: <strong /> }}
                    />
                  </p>
                )}
              </div>
            )}

            {settings.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('插件设置（来自 plugin.toml）')}</span>
                <div className="flex flex-col gap-0.5">
                  {settings.map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-3 font-mono text-xs">
                      <span className="shrink-0 text-muted-foreground">{k}</span>
                      <span className="min-w-0 truncate text-end">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
