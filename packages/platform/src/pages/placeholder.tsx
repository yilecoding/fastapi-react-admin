import { IconTool } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../shell/page-header'

/**
 * 尚未实现的管理页占位。
 *
 * 存在的意义：让后端菜单里的 path 在前端**真实存在**，
 * 侧边栏就不会把它当成死链跳过 —— 这样可以先验证整条链路，再逐个填实。
 *
 * 注：仪表盘落地后**目前没有调用方**了。保留它是因为下一个「先占位再填实」的
 * 页面还会用到（和 `pages/_shared/list-page.tsx` 同理）。
 */
export function makePlaceholder(title: string, note?: string) {
  return function Placeholder() {
    // hook 要在**内层组件**里调 —— makePlaceholder 自己是工厂函数，不是组件
    const { t } = useTranslation()
    return (
      <div className="flex flex-1 flex-col content-scroll:min-h-0">
        <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
          <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
            <PageHeader title={title} description={note} />
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
              <IconTool className="size-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('这个页面还没实现')}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
