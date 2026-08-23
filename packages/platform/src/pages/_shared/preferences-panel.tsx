import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  IconArrowsVertical,
  IconBrowser,
  IconDeviceDesktop,
  IconLayout,
  IconLayoutNavbarCollapse,
  IconMoon,
  IconPalette,
  IconRotate2,
  IconSun,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import {
  DENSITY_PRESETS,
  RADIUS_PRESETS,
  SCROLL_MODE_LABELS,
  TAB_STYLE_LABELS,
  THEME_COLORS,
  THEME_MODE_LABELS,
  usePreferences,
  type DensityPreset,
  type RadiusPreset,
  type ScrollMode,
  type TabStyle,
  type ThemeColor,
  type ThemeMode,
} from "../../shell/preferences"
import type { SettingsPanel } from "./settings-shell"
import {
  ColorSwatches,
  SegmentedControl,
  SettingRow,
  SwitchRow,
} from "./settings-rows"

/**
 * 界面偏好的面板集合。
 *
 * 放在「个人中心」下 —— 这些是**每个人自己的**界面口味，不是系统配置。
 * 所有项即时生效、即时持久化（localStorage `admin:prefs`），没有「保存」按钮：
 * 偏好改完立刻看得到效果，再点一次保存是多余的一步。
 *
 * 只放**真的接通了的**开关。界面密度通过根节点令牌即时生效；布局模式（经典侧栏/嵌入式/浮动式）
 * 仍没有侧边栏变体支撑，所以「布局」这一节现在只有滚动方式一项。
 *
 * ⚠️ 这里导出的是**面板描述数组**而不是一个完整组件：外壳（左侧竖导航 + 内容列封顶）
 * 由调用方 `profile/index.tsx` 统一持有，账号类面板和外观类面板要并进**同一条**导航。
 * 之前是「顶部页签 + 页签内左栏」两层导航，8 个小节被切成两级找。
 */
const THEME_MODES: ThemeMode[] = ["light", "dark", "system"]
const DENSITY_PRESETS_ORDER: DensityPreset[] = [
  "ultraCompact",
  "compact",
  "standard",
  "comfortable",
  "spacious",
]
const RADIUS_PRESETS_ORDER: RadiusPreset[] = [
  "sharp",
  "restrained",
  "balanced",
  "soft",
  "modern",
  "round",
]
const MODE_ICON: Record<ThemeMode, React.ReactNode> = {
  light: <IconSun className="size-3.5" />,
  dark: <IconMoon className="size-3.5" />,
  system: <IconDeviceDesktop className="size-3.5" />,
}

const SCROLL_MODES: ScrollMode[] = ["content", "page"]
const SCROLL_ICON: Record<ScrollMode, React.ReactNode> = {
  content: <IconLayoutNavbarCollapse className="size-3.5" />,
  page: <IconArrowsVertical className="size-3.5" />,
}
/** 副标写「会发生什么」，因为「内容区域 / 整页」这两个词本身分不出差别 */
const SCROLL_CAPTION: Record<ScrollMode, string> = {
  content: "顶栏固定",
  page: "顶栏跟着滚",
}

function RadiusShape({ radius }: { radius: RadiusPreset }) {
  return (
    <span
      aria-hidden
      className="h-8 w-14 border-2 border-muted-foreground/50"
      style={{ borderRadius: RADIUS_PRESETS[radius].value }}
    />
  )
}

function RadiusPreview() {
  return (
    <div
      className="flex w-full flex-wrap gap-3 rounded-xl bg-muted/40 p-3"
      data-testid="pref-radius-preview"
    >
      {["0rem", "0.625rem", "2rem"].map((radius) => (
        <div
          key={radius}
          className="flex min-w-28 flex-1 flex-col gap-3 bg-background p-3 shadow-xs"
          style={{ borderRadius: radius }}
        >
          <span className="h-2 w-2/3 rounded-full bg-primary/20" />
          <span className="h-14 rounded-[calc(var(--radius)*0.8)] bg-card ring-1 ring-border/60" />
        </div>
      ))}
    </div>
  )
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
        id: "theme",
        group: t("外观"),
        label: t("主题"),
        icon: <IconPalette />,
        content: (
          <div className="flex flex-col gap-4">
            <SettingRow
              label={t("主题模式")}
              description={t("选「系统」时跟随操作系统的深浅色设置实时切换")}
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
              label={t("主题色")}
              description={t("只换主色，语义色（成功/警告/危险）保持不变")}
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

            <SettingRow label={t("界面密度")}>
              <SegmentedControl<DensityPreset>
                value={prefs.density}
                testId="pref-density"
                onChange={(v) => patch({ density: v })}
                className="w-full max-w-2xl"
                optionClassName="min-w-0 flex-1 px-2.5 py-2"
                options={DENSITY_PRESETS_ORDER.map((key) => ({
                  value: key,
                  label: t(DENSITY_PRESETS[key].label),
                  caption: `${DENSITY_PRESETS[key].value}px · ${DENSITY_PRESETS[key].fontSize.value}px`,
                }))}
              />
            </SettingRow>

            <SettingRow label={t("圆角大小")}>
              <div className="flex flex-col gap-3">
                <SegmentedControl<RadiusPreset>
                  value={prefs.radius}
                  testId="pref-radius"
                  onChange={(v) => patch({ radius: v })}
                  className="w-full max-w-2xl"
                  optionClassName="min-w-0 flex-1 px-2 py-2"
                  iconPlacement="above"
                  // 形状图标只作为快速识别，真正的差异仍由下面三张卡片预览表达。
                  options={RADIUS_PRESETS_ORDER.map((key) => ({
                    value: key,
                    icon: <RadiusShape radius={key} />,
                    label: t(RADIUS_PRESETS[key].label),
                  }))}
                />
                {/* 三张真实卡片给出从利落到圆润的参照，避免小图标在小尺寸下难以比较。 */}
                <RadiusPreview />
              </div>
            </SettingRow>

          </div>
        ),
      },
      {
        id: "layout",
        group: t("外观"),
        label: t("布局"),
        icon: <IconLayout />,
        content: (
          <div className="flex flex-col gap-4">
            <SettingRow
              label={t("滚动方式")}
              description={t(
                "选「内容区域」时顶栏与标签条钉在原地，滚动条落在内容区右边缘；选「整页」时整份页面一起滚，导航会被滚出视口"
              )}
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
        id: "tabs",
        group: t("外观"),
        label: t("多标签页"),
        icon: <IconBrowser />,
        content: (
          <div className="flex flex-col gap-4">
            <SwitchRow
              label={t("显示多标签页")}
              description={t("关掉后顶部不再显示标签导航，页面本身照常打开")}
              checked={prefs.showTabs}
              onChange={(v) => patch({ showTabs: v })}
              testId="pref-show-tabs"
            />
            <SettingRow
              label={t("标签页外观")}
              description={t("四种样式，切换即时生效")}
            >
              <SegmentedControl<TabStyle>
                value={prefs.tabStyle}
                testId="pref-tab-style"
                onChange={(v) => patch({ tabStyle: v })}
                options={(Object.keys(TAB_STYLE_LABELS) as TabStyle[]).map(
                  (k) => ({
                    value: k,
                    label: t(TAB_STYLE_LABELS[k]),
                  })
                )}
              />
            </SettingRow>
            <SwitchRow
              label={t("显示标签页图标")}
              description={t("图标取自侧边栏菜单，取不到时显示占位点")}
              checked={prefs.tabShowIcon}
              onChange={(v) => patch({ tabShowIcon: v })}
              disabled={!prefs.showTabs}
              testId="pref-tab-icon"
            />
            <SwitchRow
              label={t("中键关闭标签页")}
              description={t("鼠标中键点标签即关闭，固定的标签不受影响")}
              checked={prefs.tabMiddleClickClose}
              onChange={(v) => patch({ tabMiddleClickClose: v })}
              disabled={!prefs.showTabs}
              testId="pref-tab-middle-close"
            />
            <SwitchRow
              label={t("拖拽调整标签顺序")}
              description={t("固定与非固定的标签分成两区，互相之间不能拖过去")}
              checked={prefs.tabDraggable}
              onChange={(v) => patch({ tabDraggable: v })}
              disabled={!prefs.showTabs}
              testId="pref-tab-draggable"
            />
          </div>
        ),
      },
      {
        id: "reset",
        group: t("其他"),
        label: t("恢复默认"),
        icon: <IconRotate2 />,
        content: (
          <SettingRow
            label={t("恢复默认偏好")}
            description={t(
              "把「外观」下的所有设置恢复成出厂值。只影响你自己这台设备上的浏览器，不动账号资料。"
            )}
            layout="inline"
          >
            <Button
              variant="outline"
              size="sm"
              data-testid="pref-reset"
              onClick={() => reset()}
            >
              <IconRotate2 className="size-4" />
              {t("恢复默认")}
            </Button>
          </SettingRow>
        ),
      },
    ],
    [prefs, patch, reset, t]
  )
}
