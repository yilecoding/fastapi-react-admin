import * as React from 'react'

import { RichTextEditor, RichTextViewer, richTextToPlain } from '@admin/ui/components/rich-text'

import { useRichTextImages } from '../../file/rich-text-images'
import { b, s, type KnobValues } from '../kit'

const SAMPLE = [
  '<h2>关于组织架构调整的公告</h2>',
  '<p>营销中心下属部门将进行整合，<strong>方案尚在讨论</strong>，以正式文件为准。</p>',
  '<ul><li><p>国内销售部与国际贸易部合并</p></li><li><p>客户服务部保持不变</p></li></ul>',
  '<blockquote><p>本公告最终解释权归综合管理部所有。</p></blockquote>',
].join('')

/**
 * 高度档位 → **字面量** class。
 *
 * 原来写的是 `min-h-${n(v, 'height')}` —— 拼出来的类名 Tailwind 扫不到，
 * 只能靠仓库别处恰好有同名字面量才生效。实测 `min-h-48` 有（编辑器默认值）、
 * `min-h-64` 有（notice/form.tsx），而 **`min-h-32` 全站一个字面量都没有**，
 * 于是那一档静默失效：选了「32」高度不变，看着像旋钮没接上。
 *
 * 这是 Tailwind `@source` 那一类问题的另一种面目 —— class 在 DOM 上，
 * CSS 规则不在。凡是要动态选类名，都得像这样列成表。
 */
const HEIGHTS: Record<string, string> = {
  '32': 'min-h-32',
  '48': 'min-h-48',
  '64': 'min-h-64',
}

/**
 * 沙箱里的富文本 demo。
 *
 * 编辑器和只读视图放一起对照 —— 它们共用同一套 Tiptap schema 和排版类，
 * 「编辑时看到的」和「发布后看到的」必须长一样，分开看根本验不出来。
 *
 * `html` 状态挂在这一层，所以**切换形态不丢内容**：在编辑器里插一张图，
 * 切到「只读视图」就能看到它发布后的样子。
 */
export function RichTextDemo({ v }: { v: KnobValues }) {
  const [html, setHtml] = React.useState(SAMPLE)
  const mode = s(v, 'mode')
  // hook 不能放在 if 后面 —— viewer 分支提前 return，所以必须在这之前调
  const images = useRichTextImages()
  const withImages = b(v, 'images')

  if (mode === 'viewer') {
    return (
      <div className="w-full rounded-md border p-4">
        <RichTextViewer value={html} />
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <RichTextEditor
        value={html}
        onChange={setHtml}
        minHeight={HEIGHTS[s(v, 'height')] ?? 'min-h-48'}
        maxLength={b(v, 'limit') ? 500 : undefined}
        disabled={b(v, 'disabled')}
        // 不传 images 时整块关掉：工具栏没有插图按钮、粘贴图片不上传。
        // 这一档就是在演示「能力靠注入」——`ui` 不能 import `platform`
        images={withImages ? images : undefined}
      />
      {withImages && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-500">
          沙箱里传的图会<strong>真的</strong>落进「文件管理」，而且因为这里没有业务对象 id，
          它不挂 <code className="font-mono">sys_file_relation</code> —— 是孤儿文件。
          正经页面要在保存时按正文里的 <code className="font-mono">data-file-id</code> diff 关联
          （见 <code className="font-mono">notice/api.ts: useSyncNoticeImages</code>）。
          玩完记得去文件管理清一下。
        </p>
      )}
      {b(v, 'showOutput') && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Out title="存进数据库的 HTML" body={html} testId="rtd-html" />
          <Out
            title="列表页摘要（richTextToPlain）"
            body={richTextToPlain(html, 120, '[图片]')}
            testId="rtd-plain"
          />
        </div>
      )}
    </div>
  )
}

function Out({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium">{title}</span>
      <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap break-all"
           data-testid={testId}>
        {body}
      </pre>
    </div>
  )
}
