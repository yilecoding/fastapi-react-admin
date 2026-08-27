import * as React from 'react'
import { useQuery } from '@tanstack/react-query'

import { sidebarQuery } from '../auth/queries'
import { MenuType, type SidebarNode } from '../api-client/sidebar-types'
// 🔴 shell 反过来 import 一个具体页面，方向上不太寻常——但组件沙箱**故意**不挂
// `sys_menu`（不占用一个业务权限码，见 `sandbox/components.tsx` 的路由注释），
// 侧边栏又是纯服务端菜单树拼出来的（见下面 `toNavTree`），没有别的地方能把
// 「开发工具 › 组件沙箱」这一条塞进去。两个消费方（这里 + command-menu.tsx）
// 都要看到它，所以放在这一个大家都会调用的 hook 里拼一次，不是各自拼一份。
import { devConfigQuery, readSandboxGate } from '../pages/dev-sandbox/api'

export type NavNode = {
  /** 雪花 ID 以字符串下发，见 sidebar-types.ts */
  id: string
  title: string
  path: string
  icon: string | null
  /** 外链（type=4）时为目标地址 */
  external: string | null
  children: NavNode[]
}

export type SidebarOptions = {
  /**
   * 判断某个 path 在前端是否真实存在。
   *
   * 由 app 注入 —— platform 不知道 `apps/web` 的 routeTree。
   * 典型实现：用 TanStack 生成的 `FileRoutesByPath` 键集合去查。
   */
  isValidPath: (path: string) => boolean
}

const warned = new Set<string>()

function warnEmbedded(node: SidebarNode) {
  if (!import.meta.env?.DEV) return
  const key = `embed:${node.id}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[sidebar] 菜单 "${node.meta.title}" 的类型是「内嵌」，但 iframeSrc 是空的，已跳过。\n` +
      `  → 在菜单管理里补上内嵌地址，或把类型改回普通菜单。`
  )
}

function warnMissing(node: SidebarNode) {
  if (!import.meta.env?.DEV) return
  const key = node.path ?? String(node.id)
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[sidebar] 菜单 "${node.meta.title}" 的 path "${node.path}" 在前端路由里不存在，已从侧边栏跳过。\n` +
      `  → 要么在 apps/web/src/routes 下补这个页面，要么在菜单管理里删掉/停用它。`
  )
}

/**
 * 后端菜单树 → 前端导航树。
 *
 * 这里执行三条规则：
 * 1. **按钮(type=2)不进侧边栏** —— 它们只提供 perms 权限标识，由 <Can> 消费
 * 2. **hideInMenu 的跳过**
 * 3. **path 在前端路由里不存在的跳过 + 开发期告警** —— 后端菜单表和前端文件路由
 *    是两套独立维护的东西，这里是它们的对账点。Vue 那套「菜单配错组件路径导致白屏」
 *    在这里退化成一条控制台警告。
 *
 * 注意 `component` 字段被完全忽略 —— 那是 Vben 的运行时动态路由概念，
 * 我们用编译期文件路由。
 */
function toNavTree(nodes: SidebarNode[], opts: SidebarOptions): NavNode[] {
  const out: NavNode[] = []
  for (const n of nodes) {
    if (n.type === MenuType.Button) continue
    if (n.meta.hideInMenu) continue

    const children = toNavTree(n.children ?? [], opts)
    const isLink = n.type === MenuType.Link
    const external = isLink ? n.meta.link || null : null

    // 内嵌(type=3)：菜单表里的 path 是给 Vben 那套运行时动态路由用的，
    // 前端没有对应的文件路由，所以原样用它必然被下面的 isValidPath 判死。
    // 统一转发到宿主页 `/embedded/<name>`（name 在菜单表里全局唯一），
    // 由宿主页读 meta.iframeSrc 渲染 iframe。
    const isEmbedded = n.type === MenuType.Iframe
    if (isEmbedded && !n.meta.iframeSrc) {
      // 配了内嵌类型却没填地址 —— 静默跳过等于「这个菜单不存在」，要说出来
      warnEmbedded(n)
      continue
    }
    const embeddedPath = isEmbedded ? `/embedded/${n.name}` : null

    // 目录(type=0)：
    //   有可见子项            → 保留为可展开分组
    //   无子项但自身 path 有效 → 降级为普通链接（种子里「仪表盘」就是这种：
    //                            它是目录且 path=/dashboard，但两个子项在前端都不存在）
    //   都不满足              → 丢弃
    if (n.type === MenuType.Directory) {
      if (children.length) {
        out.push({ id: n.id, title: n.meta.title, path: n.path ?? '', icon: n.meta.icon, external: null, children })
      } else if (n.path && opts.isValidPath(n.path)) {
        out.push({ id: n.id, title: n.meta.title, path: n.path, icon: n.meta.icon, external: null, children: [] })
      }
      continue
    }

    if (!external && !isEmbedded) {
      if (!n.path) continue
      if (!opts.isValidPath(n.path)) {
        warnMissing(n)
        // 自己没页面但子项有，仍保留为分组
        if (children.length) {
          out.push({ id: n.id, title: n.meta.title, path: '', icon: n.meta.icon, external: null, children })
        }
        continue
      }
    }

    out.push({
      id: n.id,
      title: n.meta.title,
      path: embeddedPath ?? n.path ?? '',
      icon: n.meta.icon,
      external,
      children,
    })
  }
  return out
}

/** 「开发工具 › 组件沙箱」这颗合成节点的 id 前缀 */
export const DEV_TOOLS_NODE_ID = '__dev-tools__'

/**
 * `path` 特意用 `/sandbox`、`/sandbox/components` ——
 * 语言包里 `menu:/sandbox` / `menu:/sandbox/components` 这两条翻译早就在
 * （连 en-US 的 "Sandbox" / "Components" 都有），是这个功能原来就该走
 * `sys_menu` 下发、后来没接上的遗留物。复用现成 key，不用再新增翻译。
 * `/sandbox` 本身不是真页面——目录节点在 `NavItem` 里点开是展开子项，不会真的跳转，
 * 所以它不需要在 `page-registry.tsx` 里有对应组件。
 */
function buildDevToolsNode(): NavNode {
  return {
    id: DEV_TOOLS_NODE_ID,
    title: '开发工具',
    path: '/sandbox',
    icon: 'ant-design:experiment-outlined',
    external: null,
    children: [
      {
        id: `${DEV_TOOLS_NODE_ID}:sandbox`,
        title: '组件沙箱',
        path: '/sandbox/components',
        icon: 'ant-design:experiment-outlined',
        external: null,
        children: [],
      },
    ],
  }
}

export function useSidebar(opts: SidebarOptions) {
  const { data, isPending, error } = useQuery(sidebarQuery)
  // 沙箱开不开跟侧边栏主查询是两条独立请求——这条失败或还没读回来时**不**露出这个节点，
  // 不用额外的错误态：真要用沙箱的人打开它自己的页面会看到 `QueryError`，这里只是「入口」，
  // 不是这条数据本身的展示位，悄悄不出现是可接受的降级（跟硬纪律 9 说的「业务数据」不是一回事）
  const { data: devRows } = useQuery(devConfigQuery)
  const sandboxOn = readSandboxGate(devRows, import.meta.env?.DEV ?? false).on
  const nav = React.useMemo(() => {
    const base = data ? toNavTree(data, opts) : []
    return sandboxOn ? [...base, buildDevToolsNode()] : base
  }, [data, opts, sandboxOn])
  return { nav, isPending, error }
}

/** 供测试与开发工具使用 */
export const __internal = { toNavTree }
