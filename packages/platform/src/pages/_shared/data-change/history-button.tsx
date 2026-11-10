import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconHistory } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'

import { Can } from '../../../auth/can'
import { DataChangeSheet } from './history-sheet'

/**
 * 卡片页（群机器人 / 短信配置 / 存储 / 模型密钥 / MCP 凭据…）右上角的「变更记录」图标按钮，自带抽屉（#281）。
 *
 * 列表页的行操作菜单照部门页那样在页面里放一个抽屉；卡片页每张卡片自己管自己的开关更省事 ——
 * 抽屉关着时不渲染内容、也不发请求（`enabled: open`）。没有 `log:change:list` 的人看不见按钮。
 */
export function ChangeHistoryButton({
  entity,
  entityId,
  name,
  testId,
}: {
  /** 后端登记的对象类型（`sys_data_change.entity_type`） */
  entity: string
  entityId: string
  /** 抽屉标题里显示的对象名 */
  name?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <Can perm="log:change:list">
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t('变更记录')}
        title={t('变更记录')}
        data-testid={testId}
        onClick={() => setOpen(true)}
      >
        <IconHistory className="size-4" />
      </Button>
      <DataChangeSheet entity={entity} entityId={entityId} name={name} open={open} onOpenChange={setOpen} />
    </Can>
  )
}
