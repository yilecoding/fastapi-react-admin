import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconArrowsSplit2, IconCopy, IconGitBranch, IconPlus, IconSend, IconUserCheck, IconX,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import type { AssigneeRule, Branch, Cond, FlowModel, FlowNode, FormSchema } from './api'

/**
 * 流程树的渲染：设计器（可编辑）和审批详情里的只读流程图**同一个组件**。
 *
 * 递归渲染「卡片 + 连线」，不引入 xyflow（#107 设计 8）：模型本身就是树，
 * 钉钉 / 飞书的设计器也是这个形状。
 *
 * 只读 / 可编辑、选中谁、节点状态都走 context 下发，不逐层传 prop ——
 * avc-bp 的原话：「递归渲染，逐层传 prop 易漏分支里的按钮」。
 */
type Ctx = {
  editable: boolean
  form?: FormSchema
  selected?: string | null
  onSelect?: (id: string) => void
  onInsert?: (at: InsertAt, type: FlowNode['type']) => void
  onRemove?: (id: string) => void
  onAddBranch?: (condId: string) => void
  onRemoveBranch?: (condId: string, branchId: string) => void
  /** 只读模式：节点 ID → done / current / rejected；`branch:<id>` → taken */
  state?: Record<string, string>
  /** 发布校验的问题，按节点 ID 高亮 */
  issues?: Set<string>
  userName?: (id: string) => string
  roleName?: (id: string) => string
}

export type InsertAt = { after: string } | { cond: string; branch: string }

const FlowCtx = React.createContext<Ctx>({ editable: false })

export function FlowView({ model, ...ctx }: Ctx & { model: FlowModel }) {
  const { t } = useTranslation()
  return (
    <FlowCtx.Provider value={ctx}>
      <div className="flex min-w-max flex-col items-center py-4" data-testid="flow-view">
        <Pill tone="start" id={model.root.id}>{t('发起人')}</Pill>
        <Connector at={{ after: model.root.id }} />
        <Chain node={model.root.next} />
        <Pill tone="end">{t('流程结束')}</Pill>
      </div>
    </FlowCtx.Provider>
  )
}

function Pill({ tone, id, children }: { tone: 'start' | 'end'; id?: string; children: React.ReactNode }) {
  const ctx = React.useContext(FlowCtx)
  // 设计器里「发起人」可以点：配发起人的字段权限
  const clickable = tone === 'start' && ctx.editable && !!id
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={() => clickable && id && ctx.onSelect?.(id)}
      onKeyDown={(e) => clickable && id && e.key === 'Enter' && ctx.onSelect?.(id)}
      className={cn(
        'rounded-full px-4 py-1.5 text-xs font-medium',
        tone === 'start' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        clickable && 'cursor-pointer hover:opacity-90',
        clickable && ctx.selected === id && 'ring-3 ring-primary/30'
      )}
      data-testid={tone === 'start' ? 'flow-start' : 'flow-end'}
    >
      {children}
    </div>
  )
}

function Chain({ node }: { node: FlowNode | null }) {
  const out: React.ReactNode[] = []
  let cur = node
  while (cur) {
    out.push(<NodeBlock key={cur.id} node={cur} />)
    cur = cur.next
  }
  return <>{out}</>
}

/** 连线 + 插入按钮 */
function Connector({ at, short }: { at: InsertAt; short?: boolean }) {
  const { editable, onInsert } = React.useContext(FlowCtx)
  const { t } = useTranslation()
  return (
    <div className={cn('relative flex flex-col items-center', short ? 'h-6' : 'h-12')}>
      <div className="h-full w-px bg-border" />
      {editable && onInsert && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                className="absolute top-1/2 size-6 -translate-y-1/2 rounded-full bg-background shadow-xs"
                aria-label={t('添加节点')}
                data-testid={'after' in at ? `flow-add-after-${at.after}` : `flow-add-in-${at.branch}`}
              />
            }
          >
            <IconPlus className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuItem onClick={() => onInsert(at, 'approval')} data-testid="flow-add-approval">
              <IconUserCheck className="size-4 text-amber-600" />
              {t('审批人')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onInsert(at, 'cc')} data-testid="flow-add-cc">
              <IconSend className="size-4 text-sky-600" />
              {t('抄送人')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onInsert(at, 'condition')} data-testid="flow-add-condition">
              <IconGitBranch className="size-4 text-emerald-600" />
              {t('条件分支')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

const STATE_RING: Record<string, string> = {
  done: 'border-emerald-500/60',
  current: 'border-primary ring-3 ring-primary/20',
  rejected: 'border-destructive/70',
}

function NodeBlock({ node }: { node: FlowNode }) {
  if (node.type === 'condition') return <ConditionBlock node={node} />
  return (
    <>
      <Card node={node} />
      <Connector at={{ after: node.id }} />
    </>
  )
}

function Card({ node }: { node: Exclude<FlowNode, { type: 'condition' }> }) {
  const ctx = React.useContext(FlowCtx)
  const { t } = useTranslation()
  const state = ctx.state?.[node.id]
  const isApproval = node.type === 'approval'
  const summary = isApproval
    ? describeRule(node.assignee, ctx, t) +
      (node.mode === 'all' ? ` · ${t('会签')}` : node.mode === 'seq' ? ` · ${t('依次审批')}` : '')
    : node.targets.length
      ? node.targets.map((r) => describeRule(r, ctx, t)).join('、')
      : t('未设置抄送人')
  return (
    <div
      role={ctx.editable ? 'button' : undefined}
      tabIndex={ctx.editable ? 0 : undefined}
      onClick={() => ctx.onSelect?.(node.id)}
      onKeyDown={(e) => e.key === 'Enter' && ctx.onSelect?.(node.id)}
      className={cn(
        'group relative w-64 overflow-hidden rounded-xl border bg-card text-start shadow-sm transition-shadow',
        ctx.editable && 'cursor-pointer hover:shadow-md',
        ctx.selected === node.id && 'border-primary ring-3 ring-primary/20',
        ctx.issues?.has(node.id) && 'border-destructive ring-3 ring-destructive/20',
        !ctx.editable && ctx.state && !state && 'opacity-50',
        state && STATE_RING[state]
      )}
      data-testid={`flow-node-${node.id}`}
      data-state={state}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white',
          isApproval ? 'bg-gradient-to-r from-amber-500 to-orange-500' : 'bg-gradient-to-r from-sky-500 to-blue-500'
        )}
      >
        {isApproval ? <IconUserCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
        <span className="truncate">{node.name}</span>
        {ctx.editable && ctx.onRemove && (
          <button
            type="button"
            aria-label={t('删除节点')}
            className="ms-auto rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-white/20 focus:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              ctx.onRemove?.(node.id)
            }}
            data-testid={`flow-remove-${node.id}`}
          >
            <IconX className="size-3.5" />
          </button>
        )}
      </div>
      <p className={cn('flex min-h-11 items-center px-3.5 py-2.5 text-sm', !isApproval || node.assignee ? '' : 'text-destructive')}>{summary}</p>
    </div>
  )
}

function ConditionBlock({ node }: { node: Extract<FlowNode, { type: 'condition' }> }) {
  const ctx = React.useContext(FlowCtx)
  const { t } = useTranslation()
  return (
    <>
      <div className="relative flex flex-col items-center">
        {ctx.editable && (
          <div className="z-10 -mb-3 flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 rounded-full bg-background px-2 text-xs text-emerald-700 dark:text-emerald-400"
              onClick={() => ctx.onAddBranch?.(node.id)}
              data-testid={`flow-add-branch-${node.id}`}
            >
              <IconArrowsSplit2 className="size-3.5" />
              {t('添加条件')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 rounded-full"
              aria-label={t('删除整个条件分支')}
              onClick={() => ctx.onRemove?.(node.id)}
              data-testid={`flow-remove-${node.id}`}
            >
              <IconX className="size-3.5" />
            </Button>
          </div>
        )}
        <div className="flex items-stretch">
          {node.branches.map((br, i) => (
            <BranchColumn
              key={br.id}
              cond={node}
              branch={br}
              first={i === 0}
              last={i === node.branches.length - 1}
              index={i}
            />
          ))}
        </div>
      </div>
      <Connector at={{ after: node.id }} />
    </>
  )
}

function BranchColumn({
  cond, branch, first, last, index,
}: {
  cond: Extract<FlowNode, { type: 'condition' }>
  branch: Branch
  first: boolean
  last: boolean
  index: number
}) {
  const ctx = React.useContext(FlowCtx)
  const { t } = useTranslation()
  const taken = ctx.state?.[`branch:${branch.id}`] === 'taken'
  const selectKey = `${cond.id}:${branch.id}`
  return (
    <div className="relative flex flex-col items-center px-6">
      {/* 分叉和汇合的横线：首列只画右半、末列只画左半，拼出「凹」形。
          画真的线而不是用背景色盖掉一半 —— 画布是点阵底，盖上去会留一道白条 */}
      <div aria-hidden className="absolute top-0 h-px bg-border" style={{ left: first ? '50%' : 0, right: last ? '50%' : 0 }} />
      <div aria-hidden className="absolute bottom-0 h-px bg-border" style={{ left: first ? '50%' : 0, right: last ? '50%' : 0 }} />
      <div className="h-6 w-px bg-border" />
      <div
        role={ctx.editable ? 'button' : undefined}
        tabIndex={ctx.editable ? 0 : undefined}
        onClick={() => ctx.onSelect?.(selectKey)}
        onKeyDown={(e) => e.key === 'Enter' && ctx.onSelect?.(selectKey)}
        className={cn(
          'group w-60 rounded-xl border bg-card px-3.5 py-2.5 text-start shadow-sm',
          ctx.editable && 'cursor-pointer hover:border-emerald-500/60',
          ctx.selected === selectKey && 'border-emerald-500 ring-3 ring-emerald-500/20',
          ctx.issues?.has(cond.id) && 'border-destructive',
          taken && 'border-emerald-500 ring-3 ring-emerald-500/20',
          !ctx.editable && ctx.state && !taken && 'opacity-50'
        )}
        data-testid={`flow-branch-${branch.id}`}
      >
        <div className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <span className="truncate">{branch.name}</span>
          {!branch.default && <span className="ms-auto text-muted-foreground">{t('优先级 {{n}}', { n: index + 1 })}</span>}
          {ctx.editable && !branch.default && cond.branches.length > 2 && (
            <button
              type="button"
              aria-label={t('删除这个条件')}
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-muted focus:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onRemoveBranch?.(cond.id, branch.id)
              }}
            >
              <IconX className="size-3" />
            </button>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {branch.default ? t('其他条件都不满足时走这里') : describeCond(branch.when, ctx.form, t)}
        </p>
      </div>
      <Connector at={{ cond: cond.id, branch: branch.id }} short />
      <Chain node={branch.child} />
      <div className="w-px flex-1 bg-border" />
    </div>
  )
}

// ── 文案 ─────────────────────────────────────────────────────────────────────

type T = (k: string, o?: Record<string, unknown>) => string

export function describeRule(r: AssigneeRule | null | undefined, ctx: Pick<Ctx, 'userName' | 'roleName' | 'form'>, t: T): string {
  if (!r) return t('未设置审批人')
  switch (r.kind) {
    case 'user':
      return (r.user_ids ?? []).map((id) => ctx.userName?.(id) ?? id).join('、') || t('未选择成员')
    case 'role': {
      const roles = (r.role_ids ?? []).map((id) => ctx.roleName?.(id) ?? id).join('、') || t('未选择角色')
      const scope = r.scope === 'initiator_dept' ? t('（限发起人本部门）') : r.scope === 'initiator_dept_tree' ? t('（限发起人部门及下级）') : ''
      return `${t('角色')}：${roles}${scope}`
    }
    case 'dept_leader':
      return (r.level ?? 1) === 1 ? t('直属主管') : t('第 {{n}} 级主管', { n: r.level })
    case 'initiator':
      return t('发起人自己')
    case 'var_user':
      return t('表单里的「{{f}}」', { f: ctx.form?.fields.find((f) => f.id === r.field)?.label ?? r.field ?? '?' })
    case 'select_on_start':
      return t('发起人自选')
  }
}

const OP_TEXT: Record<string, string> = {
  eq: '等于', ne: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于',
  in: '属于', not_in: '不属于', contains: '包含', empty: '为空', not_empty: '不为空',
}

export function describeCond(c: Cond | null | undefined, form: FormSchema | undefined, t: T): string {
  if (!c) return t('未设置条件')
  if ('all' in c) return c.all.map((x) => describeCond(x, form, t)).join(` ${t('且')} `) || t('未设置条件')
  if ('any' in c) return c.any.map((x) => describeCond(x, form, t)).join(` ${t('或')} `) || t('未设置条件')
  const f = form?.fields.find((x) => x.id === c.var)
  const label = c.var === '$initiator_dept' ? t('发起人部门') : (f?.label ?? c.var)
  const show = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(show).join('、')
    const opt = f?.options?.find((o) => o.value === v)
    return opt ? opt.label : String(v ?? '')
  }
  return c.op === 'empty' || c.op === 'not_empty'
    ? `${label} ${t(OP_TEXT[c.op])}`
    : `${label} ${t(OP_TEXT[c.op])} ${show(c.value)}`
}

/** 给 i18n 校验器看的字面量（`t(OP_TEXT[op])` 是动态 key，扫描器看不见） */
export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('等于'), t('不等于'), t('大于'), t('大于等于'), t('小于'), t('小于等于'), t('属于'), t('不属于'), t('包含'), t('为空'), t('不为空')]
}
