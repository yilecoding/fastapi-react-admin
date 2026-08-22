import type { ComponentType, SVGProps } from 'react'
import {
  IconActivity,
  IconAdjustments,
  IconApi,
  IconBell,
  IconBook,
  IconBrandGithub,
  IconChartArea,
  IconClipboardList,
  IconDatabaseCog,
  IconDeviceDesktopAnalytics,
  IconFiles,
  IconFileText,
  IconFlask,
  IconGauge,
  IconLayoutDashboard,
  IconLogin,
  IconMenu2,
  IconPlug,
  IconPoint,
  IconPuzzle,
  IconServer,
  IconShieldLock,
  IconSitemap,
  IconClockHour4,
  IconHistory,
  IconTimeline,
  IconUser,
  IconUserCheck,
  IconUsersGroup,
  IconWorld,
} from '@tabler/icons-react'

type IconCmp = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>

/**
 * 后端菜单表里的 icon 是 **Iconify 命名**（`ant-design:user-outlined`），
 * 而我们的 UI 包用的是 Tabler。这张表把实际用到的图标映射过来。
 *
 * 注意 icon 字段也可能是**完整 URL**（种子里 "项目" 节点就是一张 png），
 * 由 `<MenuIcon>` 统一处理，不走这张表。
 *
 * 新增菜单时若图标未命中，会回落到 `IconPoint` 并在开发期告警 —— 不会白屏。
 */
export const ICON_MAP: Record<string, IconCmp> = {
  'ant-design:dashboard-outlined': IconLayoutDashboard,
  'ant-design:experiment-outlined': IconFlask,
  'ant-design:github-filled': IconBrandGithub,
  'simple-icons:apifox': IconApi,
  'ant-design:menu-outlined': IconMenu2,
  'ant-design:profile-outlined': IconUser,
  'ant-design:user-outlined': IconUsersGroup,
  'carbon:cloud-logging': IconFileText,
  'carbon:operations-record': IconClipboardList,
  'carbon:user-role': IconUserCheck,
  'carbon:workspace': IconDeviceDesktopAnalytics,
  'clarity:plugin-line': IconPlug,
  'codicon:symbol-parameter': IconAdjustments,
  'cuida:scope-outline': IconShieldLock,
  'devicon:redis': IconDatabaseCog,
  'eos-icons:admin': IconGauge,
  'fe:notice-push': IconBell,
  'fluent-mdl2:dictionary': IconBook,
  'icon-park-outline:permissions': IconShieldLock,
  'ix:scheduler': IconTimeline,
  'mdi:clock-outline': IconClockHour4,
  'mdi:history': IconHistory,
  'lucide:area-chart': IconChartArea,
  'lucide:book-open-text': IconBook,
  'lucide:files': IconFiles,
  'material-symbols:automation': IconActivity,
  'material-symbols:rule': IconDatabaseCog,
  'mdi:login': IconLogin,
  'mdi:monitor-eye': IconDeviceDesktopAnalytics,
  'mdi:server-outline': IconServer,
  'mingcute:department-line': IconSitemap,
  'ph:puzzle-piece': IconPuzzle,
  'wpf:online': IconWorld,
}

const warned = new Set<string>()

type MenuIconProps = { name: string | null | undefined; className?: string }

export function MenuIcon({ name, className = 'size-4' }: MenuIconProps) {
  if (!name) return <IconPoint className={className} aria-hidden />

  // 种子数据里存在把 icon 写成图片 URL 的情况
  if (/^https?:\/\//.test(name)) {
    return <img src={name} alt="" className={className} aria-hidden />
  }

  const Cmp = ICON_MAP[name]
  if (!Cmp) {
    if (import.meta.env?.DEV && !warned.has(name)) {
      warned.add(name)
      console.warn(`[icon-registry] 未映射的图标 "${name}"，已回落到默认图标。请在 icon-registry.tsx 补充。`)
    }
    return <IconPoint className={className} aria-hidden />
  }
  return <Cmp className={className} aria-hidden />
}
