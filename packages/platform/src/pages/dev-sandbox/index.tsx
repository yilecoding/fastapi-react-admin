import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { IconAlertTriangle, IconCheck, IconCopy } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { cn } from '@admin/ui/lib/utils'

import { PageHeader } from '../../shell/page-header'
import { devConfigQuery, readSandboxGate } from './api'
import { DEMOS, FIRST_DEMO, demoById } from './demos'
import { defaultsOf, type KnobValues } from './kit'
import { KnobPanel } from './knobs'
import { SandboxNav } from './nav'

export type DevSandboxSearch = {
  /** 当前组件 */
  c?: string
  /** 搜索词 */
  q?: string
}

/**
 * 组件沙箱。
 *
 * 三栏：左边挑组件，中间是舞台 + 代码，右边是旋钮。
 * 旋钮改什么，舞台实时变，代码跟着变 —— 代码里**只有和默认值不同的 prop**，
 * 抄走就能用。
 *
 * 状态怎么分的：
 * - **当前组件、搜索词进 URL**（硬纪律 2）—— 翻到某个组件把链接发出去，
 *   对方打开看到的是同一屏
 * - **旋钮值留组件 state** —— 它是草稿，不是视图状态。塞进 URL 会让地址栏
 *   变成一串 variant=outline&size=lg&disabled=true，而且换个组件就全是垃圾参数
 *
 * 「数据表格」不在这里 —— 见 `pages/playground-table/`。
 */
export function DevSandboxPage({
  search = {},
  onSearchChange,
}: {
  search?: DevSandboxSearch
  onSearchChange?: (next: DevSandboxSearch) => void
}) {
  const { data: devRows, isPending } = useQuery(devConfigQuery)
  const gate = readSandboxGate(devRows, import.meta.env?.DEV ?? false)

  const active = demoById(search.c) ?? FIRST_DEMO
  const query = search.q ?? ''

  // 草稿两层：`draft[id] ?? 默认值`。不用 effect 把默认值 setState 进去 ——
  // 那样换组件时会多一次渲染，而且 <Activity> 切回来还会把改过的旋钮冲掉
  const [draft, setDraft] = React.useState<Record<string, KnobValues>>({})
  const defaults = React.useMemo(() => defaultsOf(active.knobs), [active])
  const values = draft[active.id] ?? defaults
  const dirty = draft[active.id] !== undefined

  const patch = (key: string, value: string | number | boolean) =>
    setDraft((d) => ({ ...d, [active.id]: { ...(d[active.id] ?? defaults), [key]: value } }))

  const reset = () =>
    setDraft((d) => {
      const next = { ...d }
      delete next[active.id]
      return next
    })

  const code = active.code(values)

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="组件沙箱" description="packages/ui 的组件演示台。" />
        <p className="text-sm text-muted-foreground">正在读取开发配置…</p>
      </div>
    )
  }

  if (!gate.on) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="组件沙箱" description="packages/ui 的组件演示台。" />
        <div
          className="flex max-w-xl items-start gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-5"
          data-testid="sandbox-disabled"
        >
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">组件沙箱当前是关闭的</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              原因：{gate.reason}
            </p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              在「参数配置 › 开发」里把 <code className="font-mono text-xs">DEV_SANDBOX_ENABLED</code>{' '}
              设为 <code className="font-mono text-xs">true</code> 就能打开（那一组的总开关
              <code className="font-mono text-xs"> DEV_CONFIG_STATUS</code> 也要是 1）。
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="组件沙箱" description="packages/ui 的组件演示台，旋钮改完代码可直接抄。" />

      {/*
        旋钮面板**只渲染一次**，靠 grid 定位换位置：
        窄屏跟在代码后面、xl 起变成第三栏。
        渲染两份（一份 xl:hidden、一份 hidden xl:flex）会让 data-testid 和
        控件的 id 全部重复 —— 重复 id 直接破坏 label ↔ 控件的关联，
        而隐藏的那一份还在文档树里，选择器会先命中它。
      */}
      <div className="grid gap-6 lg:grid-cols-[minmax(160px,190px)_minmax(0,1fr)] xl:grid-cols-[minmax(170px,200px)_minmax(0,1fr)_minmax(190px,230px)]">
        <SandboxNav
          demos={DEMOS}
          active={active.id}
          query={query}
          onQuery={(q) => onSearchChange?.({ ...search, q: q || undefined })}
          onSelect={(c) => onSearchChange?.({ ...search, c })}
          className="lg:col-start-1 lg:row-start-1 lg:sticky lg:top-2 lg:self-start"
        />

        <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1">
          <header className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <h2 className="font-mono text-lg font-semibold tracking-tight">{active.name}</h2>
              <span className="text-sm text-muted-foreground">{active.zh}</span>
              <span className="ms-auto font-mono text-[11px] text-muted-foreground/70">
                {active.source}
              </span>
            </div>
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              {active.summary}
            </p>
          </header>

          {/*
            例行：铺开对比。挑变体、挑尺寸靠「一次看全」，
            靠旋钮一个个切太慢。示例喂的是**默认旋钮值**而不是当前值 ——
            右栏怎么拨，这几排都不该跟着动，否则就没有基准了。
          */}
          {active.rows?.map((row) => (
            <section key={row.title} className="flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-medium">{row.title}</h3>
                <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                  {row.hint}
                </p>
              </div>
              <div
                data-testid={`sandbox-row-${row.title}`}
                className="flex flex-wrap items-start gap-x-4 gap-y-4 rounded-xl border border-border bg-muted/20 p-5"
              >
                {row.items.map((item, i) => (
                  <div
                    key={item.kind === 'action' ? item.label : `${row.title}-${i}`}
                    className="flex min-w-0 flex-col items-start gap-1.5"
                  >
                    {/*
                      示例套一层等高居中的槽：一行里 lg(40px) 和 xs(24px) 并排时，
                      顶对齐会让下面的说明文字参差不齐（实测「尺寸」那行最明显）
                    */}
                    <span className="flex min-h-10 items-center">
                      {item.kind === 'action' ? (
                        <Button variant="outline" size="sm" onClick={item.run}>
                          {item.label}
                        </Button>
                      ) : (
                        active.render({ ...defaults, ...item.values })
                      )}
                    </span>
                    {item.caption && (
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        {item.caption}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* 可调的那一个 + 它的代码。上面是对比，这里是「配一个出来抄走」 */}
          <div className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-medium">试一个</h3>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                右栏拨旋钮，下面的代码跟着变，只留和默认值不同的 prop。
              </p>
            </div>
            <div
              data-testid="sandbox-stage"
              className={cn(
                'flex min-h-[160px] rounded-xl border border-border bg-muted/25 p-6',
                active.stage === 'stretch' ? 'items-start' : 'items-center justify-center'
              )}
            >
              {active.render(values)}
            </div>
          </div>

          <CodeBlock code={code} />
        </div>

        <KnobPanel
          knobs={active.knobs}
          values={values}
          dirty={dirty}
          onChange={patch}
          onReset={reset}
          className="lg:col-start-2 lg:row-start-2 xl:col-start-3 xl:row-start-1 xl:sticky xl:top-2 xl:self-start"
        />
      </div>
    </div>
  )
}

/** 代码块 + 复制。复制成功给 1.5 秒的对勾回执，不弹 toast（这里不值得打断） */
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 非 https / 无权限时静默失败 —— 代码本身就在屏幕上，选中复制照样能拿到 */
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] tracking-[0.2em] text-muted-foreground">CODE</span>
        <Button variant="ghost" size="xs" onClick={() => void copy()} data-testid="sandbox-copy">
          {copied ? <IconCheck /> : <IconCopy />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      {/* overflow-x-auto 而不是换行：JSX 折行会把缩进读乱 */}
      <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-4 font-mono text-[12px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}
