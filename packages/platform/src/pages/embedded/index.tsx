import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconAlertTriangle, IconExternalLink } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Skeleton } from '@admin/ui/components/skeleton'

import { sidebarQuery } from '../../auth/queries'
import { MenuType, type SidebarNode } from '../../api-client/sidebar-types'

/**
 * 内嵌页面的宿主（`MenuType.embedded = 3`）。
 *
 * 后端菜单表一直支持内嵌类型，但前端此前没有承接它 —— 那类菜单会因为
 * `path` 在文件路由里找不到而被 `use-sidebar` 丢掉，只在控制台留一条警告。
 * 现在 `use-sidebar` 把它们转发到 `/embedded/<name>`，这一页负责读地址、渲染 iframe。
 *
 * 标题不写在路由的 `staticData` 里：内嵌页每个的名字都不一样，
 * `use-sync-tabs` 会在 `staticData.title` 缺失时回退到后端菜单的 `meta.title`。
 */

/** 只放行 http(s)。`javascript:` 开头的 iframe src 会**继承父页面的源**执行 —— 那是 XSS，不是内嵌 */
function safeSrc(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.origin)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function findByName(nodes: SidebarNode[], name: string): SidebarNode | undefined {
  for (const n of nodes) {
    if (n.name === name) return n
    const hit = findByName(n.children ?? [], name)
    if (hit) return hit
  }
  return undefined
}

function Notice({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div
      className="flex max-w-xl items-start gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-5"
      data-testid="embedded-notice"
    >
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{detail}</p>
        {action}
      </div>
    </div>
  )
}

export function EmbeddedPage({ params }: { params?: { name?: string } }) {
  const { t } = useTranslation()
  const name = params?.name ?? ''
  const { data, isPending, error } = useQuery(sidebarQuery)

  if (isPending) return <Skeleton className="h-[70vh] w-full rounded-xl" />

  if (error) {
    return (
      <Notice
        title={t("菜单树没读到")}
        detail={t('内嵌地址存在菜单表里，读不到菜单就拿不到地址。刷新一下，或去「菜单管理」确认这条记录还在。')}
      />
    )
  }

  const node = findByName(data ?? [], name)

  if (!node) {
    return (
      <Notice
        title={t('菜单里没有 "{{name}}"', { name })}
        detail={t('这个地址是由内嵌类型的菜单生成的。对应的菜单可能已被删除、停用，或者名称被改过。')}
      />
    )
  }

  if (node.type !== MenuType.Iframe) {
    return (
      <Notice
        title={t('"{{title}}" 不是内嵌菜单', { title: node.meta.title })}
        detail={t('只有类型为「内嵌」的菜单才会走这一页。去菜单管理把类型改成内嵌，或者直接访问它自己的路由。')}
      />
    )
  }

  const src = safeSrc(node.meta.iframeSrc)

  if (!src) {
    return (
      <Notice
        title={t("内嵌地址不可用")}
        detail={
          node.meta.iframeSrc
            ? t('地址 "{{src}}" 不是 http(s)。只有 http 和 https 会被加载 —— 其它协议（尤其 javascript:）在 iframe 里会继承本站的源执行。', { src: node.meta.iframeSrc })
            : t('这条菜单的内嵌地址是空的。去「菜单管理」补上。')
        }
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {/* 地址要看得见：内嵌页最容易让人分不清自己在看谁的东西 */}
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={src}>
          {src}
        </span>
        <Button
          variant="ghost"
          size="xs"
          // render 成 <a> 时必须声明 nativeButton={false}，否则 Base UI 会警告
          // 「按钮语义被拿掉了」—— 它默认假定渲染的是原生 <button>
          nativeButton={false}
          render={<a href={src} target="_blank" rel="noreferrer noopener" />}
        >
          <IconExternalLink />
          {t('新标签打开')}
        </Button>
      </div>
      <iframe
        // key 让换菜单时重建 iframe，而不是复用一个已经导航过的框
        key={src}
        src={src}
        title={node.meta.title}
        data-testid="embedded-frame"
        referrerPolicy="strict-origin-when-cross-origin"
        className="min-h-[70vh] w-full flex-1 rounded-xl border border-border bg-background"
      />
    </div>
  )
}
