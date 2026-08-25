import { useTranslation } from 'react-i18next'

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { Kbd, KbdGroup } from '@admin/ui/components/kbd'

import { useCommandStore } from './command-store'
import { MOD_LABEL } from './hotkeys'

/**
 * 快捷键帮助（`?` 呼出，命令面板里也有一条入口）。
 *
 * 存在的理由很朴素：**没有这一屏，快捷键只有作者知道**。
 * ⌘B 折叠侧边栏在这个仓库里存在很久了，界面上任何地方都没写过它。
 *
 * 这一屏是**手工维护**的清单，不是自动生成的 —— 快捷键分散在
 * `ui/components/sidebar.tsx`（⌘B）、`shell/command-menu.tsx`（⌘K / ?）、
 * `shell/tab-item.tsx`（中键关闭）三处，没有统一注册表。
 * ⚠️ 加新快捷键时**一并加到这里**，否则它就又变成只有作者知道的东西。
 */
export function ShortcutsDialog() {
  const { t } = useTranslation()
  const open = useCommandStore((s) => s.shortcutsOpen)
  const setOpen = useCommandStore((s) => s.setShortcutsOpen)

  const groups: Array<{ title: string; rows: Array<{ keys: string[]; label: string }> }> = [
    {
      title: t('全局'),
      rows: [
        { keys: [MOD_LABEL, 'K'], label: t('打开命令面板') },
        { keys: [MOD_LABEL, 'B'], label: t('折叠 / 展开侧边栏') },
        { keys: ['?'], label: t('打开快捷键帮助') },
      ],
    },
    {
      title: t('命令面板内'),
      rows: [
        { keys: ['↑', '↓'], label: t('上下移动') },
        { keys: ['Enter'], label: t('打开选中项') },
        { keys: ['Esc'], label: t('关闭') },
      ],
    },
    {
      title: t('标签页'),
      rows: [
        { keys: [t('中键')], label: t('关闭标签页（可在偏好设置里关掉）') },
        { keys: [t('右键')], label: t('标签页菜单（固定 / 关闭其它 / 新窗口）') },
      ],
    },
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t('快捷键')}</DialogTitle>
          <DialogDescription>
            {t('按 ? 随时打开这一屏。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-1.5">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {g.title}
              </p>
              {g.rows.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4">
                  <span className="text-sm">{row.label}</span>
                  <KbdGroup className="shrink-0">
                    {row.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </KbdGroup>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
