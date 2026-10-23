import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { IconLoader2, IconSparkles } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@admin/ui/components/dialog'
import { QueryError } from '@admin/ui/components/query-error'
import { Textarea } from '@admin/ui/components/textarea'

import { useAiGenerateDefinition, type AiDesign } from '../workflow/api'

/**
 * 设计器「一句话生成」（#111 第 1 条）。
 *
 * 结果交给 `onResult` 放进草稿（`draft ?? baseline` 那一层）—— 服务端什么都没存，人看过、点保存 / 发布才算。
 * 🔴 生成要几十秒：中途关掉弹窗 = 不要这次的结果。不丢的话，人已经接着手动改了，半分钟后整张表单被换掉。
 */
export function AiDesignDialog({
  id, open, onOpenChange, replaces, onResult,
}: {
  id: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 现在的草稿里已经有东西：生成的结果会整个替换它 */
  replaces: boolean
  onResult: (res: AiDesign) => void
}) {
  const { t } = useTranslation()
  const generate = useAiGenerateDefinition()
  const [prompt, setPrompt] = React.useState('')
  const openRef = React.useRef(open)
  openRef.current = open

  async function submit() {
    try {
      const res = await generate.mutateAsync({ id, prompt: prompt.trim() })
      if (!openRef.current) return
      onResult(res)
      onOpenChange(false)
    } catch {
      // 错误挂在弹窗里（硬纪律 9），描述留着改一改再试
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) generate.reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="wfd-ai-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconSparkles className="size-4 text-primary" />
            {t('一句话生成表单和流程')}
          </DialogTitle>
          <DialogDescription>
            {t('说清楚要填什么、谁来审、什么情况多审一级。生成的结果放进草稿，不会自动保存或发布。')}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={5}
          maxLength={2000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('例如：做一个采购申请，物品明细（名称 / 数量 / 单价 / 金额），合计自动算；超过 1 万再给上一级主管审')}
          data-testid="wfd-ai-prompt"
        />
        {replaces && (
          <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="wfd-ai-replaces">
            {t('会替换现在的表单和流程（基础信息和 AI 预审设置不动）。不满意可以不保存，返回列表时放弃修改。')}
          </p>
        )}
        {generate.isPending && (
          <p className="text-xs text-muted-foreground">{t('生成中，通常要半分钟左右。关掉弹窗就不要这次的结果。')}</p>
        )}
        {generate.error && (
          <QueryError error={generate.error} title={t('没有生成出来')} onRetry={() => void submit()} testId="wfd-ai-error" />
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>{t('取消')}</DialogClose>
          <Button onClick={submit} disabled={prompt.trim().length < 2 || generate.isPending} data-testid="wfd-ai-submit">
            {generate.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconSparkles className="size-4" />}
            {t('生成')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
