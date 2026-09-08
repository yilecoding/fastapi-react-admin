import { t } from '@admin/i18n'

import { MOD_LABEL } from '../hotkeys'
import { useTabStore } from '../tab-store'
import { inShell, tabFrame } from './targets'
import type { TourDef } from './tour'

/**
 * 外壳导览 —— 首次登录在仪表盘自动弹一次（`tour-autostart.tsx`），
 * 之后从顶栏「帮助」菜单或 ⌘K 的「功能引导」重放。
 *
 * 七步里六步是壳层元素（`inShell`），第三步「页面内容」故意指向**当前页签的内容框**
 * （`tabFrame(activeKey)`）：它是唯一一个在 `TabOutlet` 里的目标，E2E 就靠它验证
 * 「开着两个页签时高亮的是可见的那个」—— 壳层元素在文档里只有一份，验不出这件事。
 *
 * 加一步 = 这里加一条 + 目标元素上加 `data-tour="…"` + 两个语言包加文案。
 * 漏了第二步 `arch:check` 的 `dead-tour-target` 会红；漏了第三步 `i18n:check` 会红。
 */
export const SHELL_TOUR: TourDef = {
  id: 'shell',
  version: 1,
  steps: () => {
    const activeKey = useTabStore.getState().activeKey
    return [
      {
        target: inShell('sidebar'),
        title: t('侧边栏'),
        description: t('所有功能入口都在这里，按 {{mod}} B 可以把它折叠成图标栏。', { mod: MOD_LABEL }),
        side: 'right',
        align: 'start',
      },
      {
        target: inShell('tab-bar'),
        title: t('多页签'),
        description: t('每打开一个页面就多一个标签页。切走的页面不会关闭，筛选条件和滚动位置都留着；右键标签页可以固定或批量关闭。'),
        side: 'bottom',
        align: 'start',
      },
      {
        target: activeKey ? tabFrame(activeKey) : () => null,
        title: t('页面内容'),
        description: t('当前标签页的内容区。筛选、分页这些视图状态都记在地址栏里，刷新浏览器也能原样恢复。'),
        side: 'top',
        align: 'center',
      },
      {
        target: inShell('command'),
        title: t('命令面板'),
        description: t('按 {{mod}} K 搜索页面、已打开的标签页和常用操作，不用在菜单里翻。', { mod: MOD_LABEL }),
        side: 'bottom',
        align: 'end',
      },
      {
        target: inShell('notifications'),
        title: t('通知中心'),
        description: t('站内通知在这里，有新消息时铃铛上会有角标。'),
        side: 'bottom',
        align: 'end',
      },
      {
        target: inShell('user-menu'),
        title: t('个人中心'),
        description: t('修改资料、切换语言、调整主题与界面密度都在这里。'),
        side: 'bottom',
        align: 'end',
      },
      {
        target: inShell('help'),
        title: t('帮助'),
        description: t('想再看一遍这个导览、或者查快捷键，点这里。'),
        side: 'bottom',
        align: 'end',
      },
    ]
  },
}
