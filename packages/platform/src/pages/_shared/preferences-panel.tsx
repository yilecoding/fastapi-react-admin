import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconArrowsVertical, IconBrowser, IconClock, IconDeviceDesktop, IconLayout,
  IconLayoutNavbarCollapse, IconMoon, IconPalette, IconRotate2, IconSun,
} from '@tabler/icons-react'

import { BASE_TIME_ZONE } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { Combobox, type ComboboxOption } from '@admin/ui/components/combobox'
import { Input } from '@admin/ui/components/input'

import { meQuery } from '../../auth/queries'
import {
  RADIUS_PRESETS, SCROLL_MODE_LABELS, TAB_STYLE_LABELS, THEME_COLORS, THEME_MODE_LABELS,
  usePreferences,
  type RadiusPreset, type ScrollMode, type TabStyle, type ThemeColor, type ThemeMode,
} from '../../shell/preferences'
import { useSaveTimeZone } from '../profile/api'
import type { SettingsPanel } from './settings-shell'
import { ColorSwatches, SegmentedControl, SettingRow, SwitchRow } from './settings-rows'

/**
 * 界面偏好的面板集合。
 *
 * 放在「个人中心」下 —— 这些是**每个人自己的**界面口味，不是系统配置。
 * 所有项即时生效、即时持久化（localStorage `admin:prefs`），没有「保存」按钮：
 * 偏好改完立刻看得到效果，再点一次保存是多余的一步。
 *
 * 只放**真的接通了的**开关。参考实现里还有界面尺寸和「布局模式」（经典侧栏/嵌入式/浮动式），
 * 那两项要密度令牌和侧边栏变体做支撑，没做的不摆上来占位 ——
 * 所以「布局」这一节现在只有滚动方式一项，将来长出侧边栏变体就往这一节加。
 *
 * ⚠️ 这里导出的是**面板描述数组**而不是一个完整组件：外壳（左侧竖导航 + 内容列封顶）
 * 由调用方 `profile/index.tsx` 统一持有，账号类面板和外观类面板要并进**同一条**导航。
 * 之前是「顶部页签 + 页签内左栏」两层导航，8 个小节被切成两级找。
 */
const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']
const MODE_ICON: Record<ThemeMode, React.ReactNode> = {
  light: <IconSun className="size-3.5" />,
  dark: <IconMoon className="size-3.5" />,
  system: <IconDeviceDesktop className="size-3.5" />,
}

const SCROLL_MODES: ScrollMode[] = ['content', 'page']
const SCROLL_ICON: Record<ScrollMode, React.ReactNode> = {
  content: <IconLayoutNavbarCollapse className="size-3.5" />,
  page: <IconArrowsVertical className="size-3.5" />,
}
/** 副标写「会发生什么」，因为「内容区域 / 整页」这两个词本身分不出差别 */
const SCROLL_CAPTION: Record<ScrollMode, string> = {
  content: '顶栏固定',
  page: '顶栏跟着滚',
}

/**
 * 时区选择。
 *
 * ⚠️ 这一节和同一个面板里其他项**不是一类**：别的偏好存 localStorage
 * （`admin:prefs`，跟浏览器走），时区存在**服务端**（`sys_user.timezone`）——
 * 「我在哪个时区」是跟人走的，换台机器不该重新选一次。
 * 交互仍然保持一致：选完立刻存，没有保存按钮。
 *
 * 选项来自 `Intl.supportedValuesOf('timeZone')`（400+ 项，所以用可搜索的
 * Combobox 而不是 Select）。**不自己维护时区列表** —— 浏览器和后端各自跟着
 * 自己的 tzdata 走，我们维护一张表只会带来「表过期了但没人发现」。
 */
function TimeZoneSection(): React.ReactElement {
  const { t } = useTranslation()
  const me = useQuery(meQuery)
  const save = useSaveTimeZone()

  // 400+ 项，只在挂载时算一次。`hint` 放该时区**此刻**的 UTC 偏移和本地时刻，
  // 因为光看 `America/Argentina/Salta` 是不知道自己该不该选它的。
  const options = React.useMemo<ComboboxOption[]>(() => {
    const zones =
      typeof Intl.supportedValuesOf === 'function'
        ? Intl.supportedValuesOf('timeZone')
        : [BASE_TIME_ZONE]
    const now = Date.now()
    return zones.map((z) => ({
      value: z,
      label: z,
      hint: zoneHint(now, z),
    }))
  }, [])

  const current = me.data?.timezone
  const browserZone = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return null
    }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        label={t('显示时区')}
        description={t('只影响界面上时间怎么显示。日志记的时刻、定时任务什么时候跑都不受它影响')}
      >
        <div className="flex flex-col gap-2">
          <Combobox
            value={current ?? null}
            onValueChange={(v) => v && save.mutate(v)}
            options={options}
            disabled={me.isPending || save.isPending}
            data-testid="pref-timezone"
            placeholder={t('选择时区')}
            searchPlaceholder={t('搜索时区，如 Tokyo')}
            className="w-full max-w-md"
          />
          {browserZone && current && browserZone !== current && (
            <p className="text-xs text-muted-foreground" data-testid="pref-timezone-mismatch">
              {t('这台设备的系统时区是 {{zone}}，和上面选的不一致 —— 界面按上面选的显示。', {
                zone: browserZone,
              })}
            </p>
          )}
        </div>
      </SettingRow>
    </div>
  )
}

/** 该时区此刻的偏移 + 本地时刻，如 `UTC+9 · 18:20` */
function zoneHint(now: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    const hh = parts.find((p) => p.type === 'hour')?.value ?? ''
    const mm = parts.find((p) => p.type === 'minute')?.value ?? ''
    return `${offset} · ${hh}:${mm}`
  } catch {
    // 浏览器不认这个时区就不给提示，但**仍然把它列出来** ——
    // 列表来自 supportedValuesOf，理论上不会走到这里
    return ''
  }
}

/**
 * 外观类面板。
 *
 * ⚠️ 不给任何一行传「当前值提示」。第一版每行右侧都有一个 `hint`（主题模式旁写
 * 「浅色」、圆角旁写「柔和」），而分段控件里选中的那一格**已经**显示着同一个词 ——
 * 同一个值在一行里出现两次，其中一次还离控件 56px 远，读起来像两个不同的东西。
 */
export function usePreferencePanels(): SettingsPanel[] {
  const { t } = useTranslation()
  const prefs = usePreferences()
  const { patch, reset } = prefs

  return React.useMemo(
    () => [
      {
        id: 'theme',
        group: t('外观'),
        label: t('主题'),
        icon: <IconPalette />,
        content: (
          <div className="flex flex-col gap-4">
            <SettingRow
              label={t('主题模式')}
              description={t('选「系统」时跟随操作系统的深浅色设置实时切换')}
            >
              <SegmentedControl<ThemeMode>
                value={prefs.themeMode}
                testId="pref-theme-mode"
                onChange={(v) => patch({ themeMode: v })}
                options={THEME_MODES.map((m) => ({
                  value: m,
                  // 预设表是模块级常量（切语言不重算）—— 在渲染处逐条 t()
                  label: t(THEME_MODE_LABELS[m]),
                  icon: MODE_ICON[m],
                }))}
              />
            </SettingRow>

            <SettingRow
              label={t('主题色')}
              description={t('只换主色，语义色（成功/警告/危险）保持不变')}
            >
              <ColorSwatches<ThemeColor>
                value={prefs.themeColor}
                testId="pref-theme-color"
                onChange={(v) => patch({ themeColor: v })}
                options={Object.entries(THEME_COLORS).map(([key, c]) => ({
                  value: key as ThemeColor,
                  label: t(c.label),
                  color: c.primary,
                }))}
              />
            </SettingRow>

            <SettingRow
              label={t('圆角大小')}
              description={t('按钮、输入框、卡片共用同一个基准值')}
            >
              <div className="flex flex-col gap-3">
                <SegmentedControl<RadiusPreset>
                  value={prefs.radius}
                  testId="pref-radius"
                  onChange={(v) => patch({ radius: v })}
                  // ⚠️ **不要给每一档配一个「圆角形状」小图标。** 试过：14px 的方块
                  // 上画真实圆角，10px 就已经接近全圆，14px 和 20px 两档长得一模一样
                  // （半径 ≥ 边长一半时视觉上就到顶了）—— 图标既分不出高档位，
                  // 那几笔细描边挤在文字左边还很脏。要看效果就看下面的真实预览
                  options={Object.entries(RADIUS_PRESETS).map(([key, r]) => ({
                    value: key as RadiusPreset,
                    label: t(r.label),
                    // 副标写 px：「10px」比「0.625」直观（1rem = 16px）
                    caption: `${Math.round(parseFloat(r.value) * 16)}px`,
                  }))}
                />
                {/* 预览用**真实组件**而不是三个色块：`--radius` 已经是 `Button` /
                    `Input` / `Card` 的圆角来源，摆真东西上去，看到的就是改完之后
                    按钮和输入框真正的样子。色块只能表达「有多圆」，表达不了
                    「按在界面上是什么感觉」 */}
                <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3">
                  <Button type="button" size="sm" tabIndex={-1} aria-hidden>
                    {t('按钮')}
                  </Button>
                  <Input
                    readOnly tabIndex={-1} aria-hidden
                    className="h-8 w-32 bg-background"
                    value={t('输入框')}
                  />
                  <span className="rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground">
                    {t('卡片')}
                  </span>
                </div>
              </div>
            </SettingRow>
          </div>
        ),
      },
      {
        id: 'layout',
        group: t('外观'),
        label: t('布局'),
        icon: <IconLayout />,
        content: (
          <div className="flex flex-col gap-4">
            <SettingRow
              label={t('滚动方式')}
              description={t('选「内容区域」时顶栏与标签条钉在原地，滚动条落在内容区右边缘；选「整页」时整份页面一起滚，导航会被滚出视口')}
            >
              <SegmentedControl<ScrollMode>
                value={prefs.scrollMode}
                testId="pref-scroll-mode"
                onChange={(v) => patch({ scrollMode: v })}
                options={SCROLL_MODES.map((m) => ({
                  value: m,
                  label: t(SCROLL_MODE_LABELS[m]),
                  caption: t(SCROLL_CAPTION[m]),
                  icon: SCROLL_ICON[m],
                }))}
              />
            </SettingRow>
          </div>
        ),
      },
      {
        id: 'region',
        group: t('外观'),
        label: t('时区'),
        icon: <IconClock />,
        content: <TimeZoneSection />,
      },
      {
        id: 'tabs',
        group: t('外观'),
        label: t('多标签页'),
        icon: <IconBrowser />,
        content: (
          <div className="flex flex-col gap-4">
            <SwitchRow
              label={t('显示多标签页')}
              description={t('关掉后顶部不再显示标签导航，页面本身照常打开')}
              checked={prefs.showTabs}
              onChange={(v) => patch({ showTabs: v })}
              testId="pref-show-tabs"
            />
            <SettingRow label={t('标签页外观')} description={t('四种样式，切换即时生效')}>
              <SegmentedControl<TabStyle>
                value={prefs.tabStyle}
                testId="pref-tab-style"
                onChange={(v) => patch({ tabStyle: v })}
                options={(Object.keys(TAB_STYLE_LABELS) as TabStyle[]).map((k) => ({
                  value: k,
                  label: t(TAB_STYLE_LABELS[k]),
                }))}
              />
            </SettingRow>
            <SwitchRow
              label={t('显示标签页图标')}
              description={t('图标取自侧边栏菜单，取不到时显示占位点')}
              checked={prefs.tabShowIcon}
              onChange={(v) => patch({ tabShowIcon: v })}
              disabled={!prefs.showTabs}
              testId="pref-tab-icon"
            />
            <SwitchRow
              label={t('中键关闭标签页')}
              description={t('鼠标中键点标签即关闭，固定的标签不受影响')}
              checked={prefs.tabMiddleClickClose}
              onChange={(v) => patch({ tabMiddleClickClose: v })}
              disabled={!prefs.showTabs}
              testId="pref-tab-middle-close"
            />
            <SwitchRow
              label={t('拖拽调整标签顺序')}
              description={t('固定与非固定的标签分成两区，互相之间不能拖过去')}
              checked={prefs.tabDraggable}
              onChange={(v) => patch({ tabDraggable: v })}
              disabled={!prefs.showTabs}
              testId="pref-tab-draggable"
            />
          </div>
        ),
      },
      {
        id: 'reset',
        group: t('其他'),
        label: t('恢复默认'),
        icon: <IconRotate2 />,
        content: (
          <SettingRow
            label={t('恢复默认偏好')}
            description={t('把「外观」下的所有设置恢复成出厂值。只影响你自己这台设备上的浏览器，不动账号资料。')}
            layout="inline"
          >
            <Button variant="outline" size="sm" data-testid="pref-reset" onClick={() => reset()}>
              <IconRotate2 className="size-4" />
              {t('恢复默认')}
            </Button>
          </SettingRow>
        ),
      },
    ],
    [prefs, patch, reset, t]
  )
}
