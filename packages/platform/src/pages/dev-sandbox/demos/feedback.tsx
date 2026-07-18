import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Progress, ProgressLabel, ProgressValue } from '@admin/ui/components/progress'
import { Skeleton } from '@admin/ui/components/skeleton'
import { toast, type ToastTone } from '@admin/ui/components/toast'

import { action, b, jsx, lines, n, preview, s, type Demo } from '../kit'

const TONES: ToastTone[] = ['message', 'success', 'info', 'warning', 'error', 'loading']

/** 假装一个会成功/失败的请求，给 promise 那一行用 */
const fakeRequest = (ms: number, ok: boolean) =>
  new Promise<{ rows: number }>((resolve, reject) => {
    window.setTimeout(() => (ok ? resolve({ rows: 128 }) : reject(new Error('连接被重置'))), ms)
  })

export const FEEDBACK_DEMOS: Demo[] = [
  {
    id: 'toast',
    name: 'Toast',
    zh: '通知',
    group: 'feedback',
    summary:
      'manager 是模块级的，mutation 的 onError、api-client 拦截器这些非组件代码也能弹。error 和 loading 默认不自动消失 —— 一条自己溜走的报错等于没报。',
    source: 'packages/ui/src/components/toast.tsx',
    knobs: {
      tone: { kind: 'select', label: 'tone', options: TONES, default: 'success' },
      title: { kind: 'text', label: '标题', default: '已保存 3 项配置' },
      description: { kind: 'text', label: '描述', default: '' },
      action: { kind: 'bool', label: '带操作按钮', default: false },
      sticky: { kind: 'bool', label: '不自动消失', default: false, hint: '等价于 timeout: 0' },
    },
    rows: [
      {
        title: '类型',
        hint: 'message 是中性通知（无语气色）；loading 转圈且不自动消失，要靠 update 收尾。',
        items: TONES.map((tone) =>
          action(tone, () =>
            toast[tone](
              {
                message: '菜单缓存已刷新',
                success: '已保存 3 项配置',
                info: '有 2 个会话在别的设备上',
                warning: '这个角色还没有任何数据范围',
                error: '保存失败：连接被重置',
                loading: '正在导出…',
              }[tone]
            )
          )
        ),
      },
      {
        title: '单条覆盖',
        hint: '每条都能盖掉默认行为：加描述、改停留时长、挂一个操作、或者干脆不自动消失。',
        items: [
          action('带描述', () =>
            toast.success('已保存 3 项配置', {
              description: '登录策略与口令强度已同步到所有节点。',
            })
          ),
          action(
            '覆盖 duration',
            () => toast.info('这条只停 1.2 秒', { timeout: 1200 }),
            'timeout: 1200'
          ),
          action(
            '不自动消失',
            () => toast.info('这条要手动关', { timeout: 0 }),
            'timeout: 0'
          ),
          action('带 action', () =>
            toast.warning('已把 2 个成员移出该角色', {
              description: '他们会立刻失去对应菜单。',
              action: { label: '撤销', onClick: () => toast.success('已撤销') },
            })
          ),
        ],
      },
      {
        title: 'Promise 与控制',
        hint: 'loading 先弹出来占位，请求回来再把同一条改成结果 —— 不是弹第二条。',
        items: [
          action(
            'loading → success（3s）',
            () => {
              const id = toast.loading('正在导出…')
              window.setTimeout(
                () =>
                  toast.update(id, {
                    type: 'success',
                    title: '导出完成',
                    description: '共 128 行，已开始下载。',
                    timeout: 4000,
                  }),
                3000
              )
            },
            '手动 update 同一条'
          ),
          action('promise（成功）', () => {
            void toast.promise(fakeRequest(1600, true), {
              loading: '正在提交…',
              success: (r) => ({ title: '提交成功', description: `写入 ${r.rows} 行` }),
              error: (e) => ({ title: '提交失败', description: String(e) }),
            })
          }),
          action('promise（失败）', () => {
            void toast
              .promise(fakeRequest(1600, false), {
                loading: '正在提交…',
                success: '提交成功',
                error: (e) => ({ title: '提交失败', description: String(e) }),
              })
              // promise 失败会原样抛出来，这里吞掉免得变成 unhandledrejection
              .catch(() => {})
          }),
          action(
            '批量触发',
            () => {
              for (let i = 1; i <= 6; i += 1) toast.message(`第 ${i} 条`)
            },
            '超出 limit 的会被标记 data-limited'
          ),
          action('关闭所有', () => toast.dismiss()),
        ],
      },
    ],
    render: (v) => {
      const tone = s(v, 'tone') as ToastTone
      return (
        <div className="flex flex-col items-center gap-3">
          <Button
            onClick={() =>
              toast[tone](s(v, 'title'), {
                description: s(v, 'description') || undefined,
                ...(b(v, 'sticky') ? { timeout: 0 } : {}),
                ...(b(v, 'action')
                  ? { action: { label: '撤销', onClick: () => toast.success('已撤销') } }
                  : {}),
              })
            }
          >
            弹一条 {tone}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.dismiss()}>
            全部关掉
          </Button>
        </div>
      )
    },
    code: (v) => {
      const opts = lines(
        s(v, 'description') && `  description: '${s(v, 'description')}',`,
        b(v, 'sticky') && '  timeout: 0,',
        b(v, 'action') && "  action: { label: '撤销', onClick: undo },"
      )
      const call = `toast.${s(v, 'tone')}('${s(v, 'title')}'`
      return opts ? `${call}, {\n${opts}\n})` : `${call})`
    },
  },

  {
    id: 'progress',
    name: 'Progress',
    zh: '进度',
    group: 'feedback',
    summary: '已知总量的进度。总量未知（等接口回来）用 Skeleton 或转圈，不要拿它假装。',
    source: 'packages/ui/src/components/progress.tsx',
    knobs: {
      value: { kind: 'int', label: 'value', default: 62, min: 0, max: 100 },
      label: { kind: 'bool', label: '带标题与数值', default: true },
      width: { kind: 'select', label: '宽度', options: ['w-40', 'w-56', 'w-72'], default: 'w-56' },
    },
    rows: [
      {
        title: '取值',
        hint: '0 和 100 是两个容易漏测的端点：0 要看得出轨道，100 要填满不溢出。',
        items: [
          preview({ value: 0, label: false }, '0'),
          preview({ value: 45, label: false }, '45'),
          preview({ value: 100, label: false }, '100'),
        ],
      },
      {
        title: '带标签',
        hint: 'ProgressValue 会自己格式化成百分比，不用另算。',
        items: [preview({ value: 62, label: true }, 'label + value')],
      },
    ],
    render: (v) => (
      <Progress value={n(v, 'value')} className={s(v, 'width')}>
        {b(v, 'label') && (
          <>
            <ProgressLabel>导入进度</ProgressLabel>
            <ProgressValue />
          </>
        )}
      </Progress>
    ),
    code: (v) =>
      jsx(
        'Progress',
        { value: n(v, 'value') },
        b(v, 'label')
          ? lines('<ProgressLabel>导入进度</ProgressLabel>', '<ProgressValue />')
          : undefined
      ),
  },

  {
    id: 'skeleton',
    name: 'Skeleton',
    zh: '骨架',
    group: 'feedback',
    summary:
      '占位要和真实内容同形同位。DataTable 自己管加载态（传 loading），页面里不要再写「isPending ? 骨架 : 表格」—— 那会让筛选栏在加载完成时凭空出现。',
    source: 'packages/ui/src/components/skeleton.tsx',
    knobs: {
      shape: {
        kind: 'select',
        label: '形状',
        options: ['文本行', '卡片', '头像行', '表格行'],
        default: '文本行',
      },
    },
    rows: [
      {
        title: '常见形状',
        hint: '宽度要参差 —— 三条一样长的灰条看着像故障，不像正在加载的文字。',
        items: [
          preview({ shape: '文本行' }, '文本'),
          preview({ shape: '头像行' }, '头像 + 两行'),
          preview({ shape: '卡片' }, '卡片'),
          preview({ shape: '表格行' }, '表格行'),
        ],
      },
    ],
    render: (v) => {
      const shape = s(v, 'shape')
      if (shape === '卡片') return <Skeleton className="h-24 w-52 rounded-xl" />
      if (shape === '头像行')
        return (
          <div className="flex w-56 items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-36" />
            </div>
          </div>
        )
      if (shape === '表格行')
        return (
          <div className="flex w-64 flex-col gap-2.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3.5 w-12" />
              </div>
            ))}
          </div>
        )
      return (
        <div className="flex w-56 flex-col gap-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      )
    },
    code: (v) => {
      const shape = s(v, 'shape')
      if (shape === '卡片') return '<Skeleton className="h-24 w-52 rounded-xl" />'
      if (shape === '头像行')
        return lines(
          '<div className="flex items-center gap-3">',
          '  <Skeleton className="size-9 rounded-full" />',
          '  <div className="flex flex-1 flex-col gap-2">',
          '    <Skeleton className="h-3.5 w-24" />',
          '    <Skeleton className="h-3 w-36" />',
          '  </div>',
          '</div>'
        )
      if (shape === '表格行')
        return lines(
          '<div className="flex items-center gap-3">',
          '  <Skeleton className="size-4 rounded" />',
          '  <Skeleton className="h-3.5 flex-1" />',
          '  <Skeleton className="h-3.5 w-12" />',
          '</div>'
        )
      return lines(
        '<div className="flex flex-col gap-2">',
        '  <Skeleton className="h-3.5 w-full" />',
        '  <Skeleton className="h-3.5 w-4/5" />',
        '  <Skeleton className="h-3.5 w-2/3" />',
        '</div>'
      )
    },
  },

  {
    id: 'badge',
    name: 'Badge',
    zh: '徽标',
    group: 'feedback',
    summary:
      '短状态标签。**业务状态（正常/停用）不要在这里手搭** —— 走 pages/_shared/status.tsx 的 StatusBadge，色板只在那一处定义。',
    source: 'packages/ui/src/components/badge.tsx',
    knobs: {
      variant: {
        kind: 'select',
        label: 'variant',
        options: ['default', 'secondary', 'outline', 'destructive', 'ghost', 'link'],
        default: 'secondary',
      },
      children: { kind: 'text', label: '文案', default: '待审核' },
    },
    rows: [
      {
        title: '变体',
        hint: 'secondary 是默认选择；default 那么重的底色一屏出现十几个就成噪音了。',
        items: [
          preview({ variant: 'default', children: 'default' }),
          preview({ variant: 'secondary', children: 'secondary' }),
          preview({ variant: 'outline', children: 'outline' }),
          preview({ variant: 'destructive', children: 'destructive' }),
          preview({ variant: 'ghost', children: 'ghost' }),
        ],
      },
      {
        title: '真实用法',
        hint: '徽标里的数字要 tabular-nums，否则一列数字宽窄跳动。',
        items: [
          preview({ variant: 'secondary', children: '待审核' }),
          preview({ variant: 'outline', children: 'v1.0.0' }),
          preview({ variant: 'destructive', children: '已停用' }),
          preview({ variant: 'secondary', children: '12' }),
        ],
      },
    ],
    render: (v) => (
      <Badge variant={s(v, 'variant') as 'default'} className="tabular-nums">
        {s(v, 'children')}
      </Badge>
    ),
    code: (v) =>
      jsx(
        'Badge',
        { variant: s(v, 'variant') === 'default' ? undefined : s(v, 'variant') },
        s(v, 'children')
      ),
  },
]
