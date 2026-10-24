import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { IconMinus, IconPlus, IconTrash } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { MultiSelect } from '@admin/ui/components/multi-select'
import { Switch } from '@admin/ui/components/switch'
import { cn } from '@admin/ui/lib/utils'

import { FormField as Row } from '../_shared/form-fields'
import {
  directoryRolesQuery, directoryUsersQuery,
  type AiApproveConfig, type ApprovalNode, type AssigneeRule, type Branch, type CcNode, type Cond, type CondOp, type FieldPerm,
  type ApprovalMode, type FlowModel, type FormSchema, type OptionalAction,
} from '../workflow/api'
import {
  addBranch, blankNode, findNode, insertAfter, insertBranchHead, patchBranch, patchNode, removeBranch, removeNode,
} from '../workflow/flow-edit'
import { FlowView, type InsertAt } from '../workflow/flow-view'
import { DeptSelect, UserSelect } from '../workflow/pickers'

/**
 * 流程设计器：画布（`FlowView` 可编辑模式）+ 右侧属性面板。
 *
 * 选中的东西写进 URL（`sel`，节点 ID 或 `条件ID:分支ID`），刷新不丢（#107 设计 8）。
 */
export function FlowDesigner({
  model,
  form,
  onChange,
  selected,
  onSelect,
  issueNodes,
}: {
  model: FlowModel
  form: FormSchema
  onChange: (m: FlowModel) => void
  selected: string | null
  onSelect: (id: string | null) => void
  issueNodes: Set<string>
}) {
  const { t } = useTranslation()
  const roles = useQuery(directoryRolesQuery()).data
  // 画布上要显示指定成员的名字：把模型里出现过的用户 ID 一次查回来
  const userIds = React.useMemo(() => collectUserIds(model), [model])
  const users = useQuery({ ...directoryUsersQuery({ ids: userIds }), enabled: userIds.length > 0 }).data
  const userName = React.useCallback((id: string) => users?.find((u) => u.id === id)?.nickname ?? '…', [users])
  const roleName = React.useCallback((id: string) => roles?.find((r) => r.id === id)?.name ?? id, [roles])

  // 缩放用 CSS `zoom` 而不是 transform：transform 不改占位尺寸，缩小后滚动区还是原来那么大
  const [zoom, setZoom] = React.useState(1)

  const onInsert = (at: InsertAt, type: 'approval' | 'cc' | 'condition') => {
    const node = blankNode(type)
    onChange('after' in at ? insertAfter(model, at.after, node) : insertBranchHead(model, at.cond, at.branch, node))
    onSelect(node.type === 'condition' ? `${node.id}:${node.branches[0].id}` : node.id)
  }

  const isStart = selected === model.root.id
  const [condId, branchId] = selected?.includes(':') ? selected.split(':') : [null, null]
  const node = selected && !condId ? findNode(model, selected) : null
  const cond = condId ? findNode(model, condId) : null
  const branch = cond?.type === 'condition' ? cond.branches.find((b) => b.id === branchId) : undefined

  return (
    <div className="grid min-h-[36rem] gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="relative overflow-hidden rounded-xl border bg-muted/40">
        <ZoomBar zoom={zoom} onZoom={setZoom} />
        <div
          className="h-full max-h-[calc(100svh-15rem)] min-h-[36rem] overflow-auto bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:18px_18px]"
          data-testid="flow-canvas"
        >
          <div style={{ zoom }} className="flex justify-center">
        <FlowView
          model={model}
          form={form}
          editable
          selected={selected}
          onSelect={onSelect}
          onInsert={onInsert}
          onRemove={(id) => {
            onChange(removeNode(model, id))
            if (selected?.startsWith(id)) onSelect(null)
          }}
          onAddBranch={(id) => onChange(addBranch(model, id))}
          onRemoveBranch={(c, b) => {
            onChange(removeBranch(model, c, b))
            if (selected === `${c}:${b}`) onSelect(null)
          }}
          issues={issueNodes}
          userName={userName}
          roleName={roleName}
        />
          </div>
        </div>
      </div>
      <aside
        className="flex max-h-[calc(100svh-15rem)] flex-col gap-4 overflow-y-auto rounded-xl border bg-card p-4 lg:sticky lg:top-4"
        data-testid="flow-props"
      >
        {isStart ? (
          <StartProps
            perms={model.root.fieldPerms ?? {}}
            form={form}
            onChange={(fieldPerms) => onChange({ ...model, root: { ...model.root, fieldPerms } })}
          />
        ) : node?.type === 'approval' ? (
          <ApprovalProps
            node={node}
            form={form}
            reviewOn={!!model.aiReview?.enabled}
            onChange={(p) => onChange(patchNode<ApprovalNode>(model, node.id, p))}
          />
        ) : node?.type === 'cc' ? (
          <CcProps node={node} form={form} onChange={(p) => onChange(patchNode<CcNode>(model, node.id, p))} />
        ) : branch && cond ? (
          <BranchProps
            branch={branch}
            form={form}
            onChange={(p) => onChange(patchBranch(model, cond.id, branch.id, p))}
          />
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('点画布上的节点编辑它；点连线上的「+」添加节点；点「发起人」配发起人能填哪些字段')}</p>
        )}
      </aside>
    </div>
  )
}

function ZoomBar({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  const { t } = useTranslation()
  const step = (d: number) => onZoom(Math.min(1.5, Math.max(0.5, Math.round((zoom + d) * 10) / 10)))
  return (
    <div className="absolute end-3 top-3 z-20 flex items-center rounded-lg border bg-background/90 shadow-xs backdrop-blur">
      <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('缩小')} onClick={() => step(-0.1)}>
        <IconMinus className="size-3.5" />
      </Button>
      <button
        type="button"
        className="w-12 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
        onClick={() => onZoom(1)}
        title={t('恢复 100%')}
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('放大')} onClick={() => step(0.1)}>
        <IconPlus className="size-3.5" />
      </Button>
    </div>
  )
}

function collectUserIds(model: FlowModel): string[] {
  const out = new Set<string>()
  const scan = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const o = n as Record<string, unknown>
    if (Array.isArray(o.user_ids)) for (const id of o.user_ids) out.add(String(id))
    for (const v of Object.values(o)) if (v && typeof v === 'object') scan(v)
  }
  scan(model.root)
  return [...out].sort()
}

// ── 审批人规则 ───────────────────────────────────────────────────────────────

const KINDS: { kind: AssigneeRule['kind']; label: string }[] = [
  { kind: 'dept_leader', label: '部门主管' },
  { kind: 'user', label: '指定成员' },
  { kind: 'role', label: '指定角色' },
  { kind: 'select_on_start', label: '发起人自选' },
  { kind: 'var_user', label: '表单里的人员' },
  { kind: 'initiator', label: '发起人自己' },
]

function Segmented<T extends string>({
  value, items, onChange, testId,
}: {
  value: T
  items: { value: T; label: string }[]
  onChange: (v: T) => void
  testId?: string
}) {
  return (
    <div className="flex flex-wrap gap-1" data-testid={testId}>
      {items.map((x) => (
        <button
          key={x.value}
          type="button"
          onClick={() => onChange(x.value)}
          className={cn(
            'rounded-md border px-2 py-1 text-xs',
            value === x.value ? 'border-primary bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
          data-testid={testId ? `${testId}-${x.value}` : undefined}
        >
          {x.label}
        </button>
      ))}
    </div>
  )
}

function RuleEditor({
  rule, form, onChange, allowSelectOnStart = true, testId = 'rule',
}: {
  rule: AssigneeRule | null | undefined
  form: FormSchema
  onChange: (r: AssigneeRule) => void
  allowSelectOnStart?: boolean
  testId?: string
}) {
  const { t } = useTranslation()
  const roles = useQuery(directoryRolesQuery()).data ?? []
  const kinds = KINDS.filter((k) => allowSelectOnStart || k.kind !== 'select_on_start')
  const userFields = form.fields.filter((f) => f.type === 'user')
  // 没配的时候**什么都不选中** —— 默认高亮一个「部门主管」而模型里其实是空的，
  // 发布时报「未设置审批人」，用户会以为校验坏了
  const r: AssigneeRule | null = rule ?? null
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={(r?.kind ?? '') as AssigneeRule['kind']}
        items={kinds.map((k) => ({ value: k.kind, label: t(k.label) }))}
        onChange={(kind) => onChange({ kind, ...(kind === 'dept_leader' ? { level: 1 } : {}), ...(kind === 'role' ? { scope: 'none' } : {}) })}
        testId={`${testId}-kind`}
      />
      {r?.kind === 'dept_leader' && (
        <Row label={t('第几级主管')} hint={t('第 1 级 = 发起人所在部门的负责人；负责人是发起人自己或没配时自动往上找')}>
          <Input
            type="number"
            min={1}
            max={10}
            value={r.level ?? 1}
            onChange={(e) => onChange({ ...r, level: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            data-testid={`${testId}-level`}
          />
        </Row>
      )}
      {r?.kind === 'user' && (
        <UserSelect value={r.user_ids ?? []} multiple onChange={(v) => onChange({ ...r, user_ids: v })} testId={`${testId}-users`} />
      )}
      {r?.kind === 'role' && (
        <>
          <MultiSelect
            value={r.role_ids ?? []}
            onValueChange={(v) => onChange({ ...r, role_ids: v })}
            options={roles.map((x) => ({ value: x.id, label: x.name, hint: x.code }))}
            placeholder={t('选择角色')}
          />
          <Row label={t('范围')} hint={t('只取发起人部门（或部门及下级）里有这个角色的人；取不到时按「找不到审批人」处理，不会放开成全公司')}>
            <Segmented
              value={r.scope ?? 'none'}
              items={[
                { value: 'none', label: t('不限') },
                { value: 'initiator_dept', label: t('发起人本部门') },
                { value: 'initiator_dept_tree', label: t('本部门及下级') },
              ]}
              onChange={(scope) => onChange({ ...r, scope })}
            />
          </Row>
        </>
      )}
      {r?.kind === 'var_user' && (
        userFields.length ? (
          <Segmented
            value={r.field ?? ''}
            items={userFields.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(field) => onChange({ ...r, field })}
          />
        ) : (
          <p className="text-sm text-destructive">{t('表单里还没有「人员」字段')}</p>
        )
      )}
      {r?.kind === 'select_on_start' && (
        <p className="text-xs text-muted-foreground">{t('发起时由发起人从全体员工里选，必须选至少一人')}</p>
      )}
    </div>
  )
}

function ApprovalProps({
  node, form, reviewOn, onChange,
}: {
  node: ApprovalNode
  form: FormSchema
  /** 流程开了 AI 预审没有（AI 自动同意的依据就是预审结论） */
  reviewOn: boolean
  onChange: (p: Partial<ApprovalNode>) => void
}) {
  const { t } = useTranslation()
  const actions = node.actions ?? null
  const fieldPerms = node.fieldPerms ?? {}
  const toggleAction = (a: OptionalAction, on: boolean) => {
    const base = actions ?? OPTIONAL_ACTIONS.map(([x]) => x)
    const next = on ? [...new Set([...base, a])] : base.filter((x) => x !== a)
    onChange({ actions: next })
  }
  return (
    <>
      <Row label={t('节点名称')} required>
        <Input value={node.name} maxLength={64} onChange={(e) => onChange({ name: e.target.value })} data-testid="node-name" />
      </Row>
      <Row label={t('审批人')} required>
        <RuleEditor rule={node.assignee} form={form} onChange={(assignee) => onChange({ assignee })} testId="node-rule" />
      </Row>
      <Row label={t('多人审批时')} hint={t(MODE_HINT[node.mode])}>
        <Segmented
          value={node.mode}
          items={[
            { value: 'any', label: t('或签') },
            { value: 'all', label: t('会签') },
            { value: 'seq', label: t('依次审批') },
          ]}
          onChange={(mode) => onChange({ mode })}
          testId="node-mode"
        />
      </Row>
      <TimeoutEditor value={node.timeout ?? null} onChange={(timeout) => onChange({ timeout })} />
      <AiApproveEditor
        value={node.aiApprove ?? null}
        orSign={(node.mode ?? 'any') === 'any'}
        reviewOn={reviewOn}
        onChange={(aiApprove) => onChange({ aiApprove })}
      />
      <Row label={t('找不到审批人时')} hint={t('必须显式选：发起人自己被去掉、部门没配负责人、角色里没人，都会走到这里')}>
        <Segmented
          value={node.onEmpty}
          items={[
            { value: 'reject', label: t('自动驳回') },
            { value: 'skip', label: t('自动跳过') },
            { value: 'admin', label: t('转给管理员') },
          ]}
          onChange={(onEmpty) => onChange({ onEmpty })}
          testId="node-empty"
        />
      </Row>
      <Row label={t('允许的操作')} hint={t('同意 / 驳回始终可用，不能关掉')}>
        <div className="flex flex-col gap-2 text-sm">
          {OPTIONAL_ACTIONS.map(([a, label]) => (
            <label key={a} className="flex items-center justify-between">
              {t(label)}
              <Switch
                checked={actions === null || actions.includes(a)}
                onCheckedChange={(v) => toggleAction(a, v)}
                data-testid={`node-action-${a}`}
              />
            </label>
          ))}
        </div>
      </Row>
      <Row label={t('字段权限')} hint={t('只对这个节点的审批人生效；隐藏的字段服务端直接不下发')}>
        <div className="flex flex-col gap-1">
          {form.fields.filter((f) => f.type !== 'description').map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{f.label}</span>
              <Segmented
                value={fieldPerms[f.id] ?? 'readonly'}
                items={[
                  { value: 'hidden' as FieldPerm, label: t('隐藏') },
                  { value: 'readonly' as FieldPerm, label: t('只读') },
                  { value: 'editable' as FieldPerm, label: t('可编辑') },
                ]}
                onChange={(p) => onChange({ fieldPerms: { ...fieldPerms, [f.id]: p } })}
                testId={`node-perm-${f.id}`}
              />
            </div>
          ))}
        </div>
      </Row>
    </>
  )
}

/** 发起人的字段权限。默认可填；hidden = 留给审批人填、发起人也看不到（比如「人事备注」） */
function StartProps({
  perms, form, onChange,
}: {
  perms: Record<string, FieldPerm>
  form: FormSchema
  onChange: (p: Record<string, FieldPerm>) => void
}) {
  const { t } = useTranslation()
  return (
    <Row label={t('发起人的字段权限')} hint={t('隐藏的字段发起人不填也看不到，留给后面的审批节点设成「可编辑」去填')}>
      <div className="flex flex-col gap-1" data-testid="start-props">
        {form.fields.filter((f) => f.type !== 'description').map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{f.label}</span>
            <Segmented
              value={perms[f.id] ?? 'editable'}
              items={[
                { value: 'hidden' as FieldPerm, label: t('隐藏') },
                { value: 'readonly' as FieldPerm, label: t('只读') },
                { value: 'editable' as FieldPerm, label: t('可编辑') },
              ]}
              onChange={(p) => onChange({ ...perms, [f.id]: p })}
              testId={`start-perm-${f.id}`}
            />
          </div>
        ))}
      </div>
    </Row>
  )
}

function CcProps({ node, form, onChange }: { node: CcNode; form: FormSchema; onChange: (p: Partial<CcNode>) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <Row label={t('节点名称')} required>
        <Input value={node.name} maxLength={64} onChange={(e) => onChange({ name: e.target.value })} />
      </Row>
      <Row label={t('抄送给')}>
        <div className="flex flex-col gap-3">
          {node.targets.map((r, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-md border p-2">
              <RuleEditor
                rule={r}
                form={form}
                allowSelectOnStart={false}
                onChange={(nr) => onChange({ targets: node.targets.map((x, j) => (j === i ? nr : x)) })}
                testId={`cc-rule-${i}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-end text-destructive"
                onClick={() => onChange({ targets: node.targets.filter((_, j) => j !== i) })}
              >
                <IconTrash className="size-3.5" />
                {t('移除')}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => onChange({ targets: [...node.targets, { kind: 'user', user_ids: [] }] })}
            data-testid="cc-add-rule"
          >
            <IconPlus className="size-4" />
            {t('添加抄送人')}
          </Button>
        </div>
      </Row>
    </>
  )
}

// ── 条件 ─────────────────────────────────────────────────────────────────────

export type Leaf = { var: string; op: CondOp; value?: unknown }

export const OPS_BY_TYPE: Record<string, CondOp[]> = {
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'],
  amount: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'],
  date: ['gt', 'gte', 'lt', 'lte', 'eq'],
  text: ['eq', 'ne', 'empty', 'not_empty'],
  select: ['in', 'not_in'],
  multiselect: ['contains'],
  user: ['in', 'not_in'],
  dept: ['in', 'not_in'],
  $initiator_dept: ['in', 'not_in'],
}

const OP_LABEL: Record<CondOp, string> = {
  eq: '等于', ne: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于',
  in: '属于', not_in: '不属于', contains: '包含', empty: '为空', not_empty: '不为空',
}

/**
 * 条件编辑器：一组「且」关系的条件。
 *
 * 数据形状支持 `all` / `any` 任意嵌套（后端 `engine/flow.py: evaluate`），界面这一版只编辑
 * 一层「全部满足」—— 要「或」就拆成两条分支，飞书 / 钉钉的设计器也是这么引导的。
 * 打开一个界面编辑不了的条件（手写的 any 嵌套）时**不改写它**，只提示，免得一点就丢。
 */
function BranchProps({
  branch, form, onChange,
}: {
  branch: Branch
  form: FormSchema
  onChange: (p: Partial<Branch>) => void
}) {
  const { t } = useTranslation()
  const condFields = form.fields.filter((f) => f.type in OPS_BY_TYPE)
  const when = branch.when
  const editable = !when || ('all' in when && when.all.every((c) => 'var' in c))
  const leaves = (when && 'all' in when ? when.all : []) as Leaf[]
  const setLeaves = (next: Leaf[]) => onChange({ when: next.length ? { all: next as Cond[] } : null })

  if (branch.default) {
    return (
      <>
        <Row label={t('分支名称')}>
          <Input value={branch.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Row>
        <p className="text-sm text-muted-foreground">{t('兜底分支：其他条件都不满足时走这里，不需要设置条件')}</p>
      </>
    )
  }
  return (
    <>
      <Row label={t('分支名称')} required>
        <Input value={branch.name} maxLength={64} onChange={(e) => onChange({ name: e.target.value })} data-testid="branch-name" />
      </Row>
      <Row label={t('同时满足以下条件')}>
        {!editable ? (
          <p className="text-sm text-amber-700">{t('这个条件比较复杂，设计器编辑不了；保持原样不会被改动')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {leaves.map((c, i) => (
              <LeafEditor
                key={i}
                leaf={c}
                form={form}
                onChange={(nc) => setLeaves(leaves.map((x, j) => (j === i ? nc : x)))}
                onRemove={() => setLeaves(leaves.filter((_, j) => j !== i))}
                index={i}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={condFields.length === 0}
              onClick={() => {
                const f = condFields[0]
                setLeaves([...leaves, { var: f.id, op: OPS_BY_TYPE[f.type][0] }])
              }}
              data-testid="branch-add-cond"
            >
              <IconPlus className="size-4" />
              {t('添加条件')}
            </Button>
            {condFields.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('表单里还没有能当条件的字段（数字 / 金额 / 单选 / 人员 / 部门…）')}</p>
            )}
          </div>
        )}
      </Row>
    </>
  )
}

export function LeafEditor({
  leaf, form, onChange, onRemove, index, builtins = true, testPrefix = 'cond',
}: {
  leaf: Leaf
  form: FormSchema
  onChange: (l: Leaf) => void
  onRemove: () => void
  index: number
  /** 「发起人部门」这种内置变量：表单的显示条件里没有（只认表单字段） */
  builtins?: boolean
  testPrefix?: string
}) {
  const { t } = useTranslation()
  const fields = [
    ...form.fields.filter((f) => f.type in OPS_BY_TYPE).map((f) => ({ value: f.id, label: f.label, type: f.type as string })),
    ...(builtins ? [{ value: '$initiator_dept', label: t('发起人部门'), type: '$initiator_dept' }] : []),
  ]
  const field = form.fields.find((f) => f.id === leaf.var)
  const type = leaf.var === '$initiator_dept' ? '$initiator_dept' : (field?.type ?? 'text')
  const ops = OPS_BY_TYPE[type] ?? ['eq']
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : v === undefined || v === null ? [] : [String(v)])

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2" data-testid={`${testPrefix}-${index}`}>
      <div className="flex items-center gap-1">
        <select
          className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm"
          value={leaf.var}
          onChange={(e) => {
            const nt = fields.find((f) => f.value === e.target.value)?.type ?? 'text'
            onChange({ var: e.target.value, op: (OPS_BY_TYPE[nt] ?? ['eq'])[0] })
          }}
          data-testid={`${testPrefix}-${index}-var`}
        >
          {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          value={leaf.op}
          onChange={(e) => onChange({ ...leaf, op: e.target.value as CondOp })}
          data-testid={`${testPrefix}-${index}-op`}
        >
          {ops.map((o) => <option key={o} value={o}>{t(OP_LABEL[o])}</option>)}
        </select>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t('删除条件')} onClick={onRemove}>
          <IconTrash className="size-3.5" />
        </Button>
      </div>
      {leaf.op === 'empty' || leaf.op === 'not_empty' ? null : type === 'select' || type === 'multiselect' ? (
        <MultiSelect
          value={arr(leaf.value)}
          onValueChange={(v) => onChange({ ...leaf, value: type === 'multiselect' ? v[0] : v })}
          options={(field?.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          placeholder={t('选择取值')}
        />
      ) : type === 'user' ? (
        <UserSelect value={arr(leaf.value)} multiple onChange={(v) => onChange({ ...leaf, value: v })} />
      ) : type === 'dept' || type === '$initiator_dept' ? (
        <DeptMulti value={arr(leaf.value)} onChange={(v) => onChange({ ...leaf, value: v })} />
      ) : (
        <Input
          className="h-8"
          type={type === 'date' ? 'date' : 'text'}
          inputMode={type === 'number' || type === 'amount' ? 'decimal' : undefined}
          value={leaf.value === undefined || leaf.value === null ? '' : String(leaf.value)}
          onChange={(e) => {
            const raw = e.target.value
            // 数字按数字存、金额按字符串存（后端统一转 Decimal 比较），日期按 YYYY-MM-DD
            onChange({ ...leaf, value: type === 'number' && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw })
          }}
          data-testid={`${testPrefix}-${index}-value`}
        />
      )}
    </div>
  )
}

/** 部门多选（条件「属于」用）：在单选控件上叠一个已选列表 */
function DeptMulti({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      {value.map((id) => (
        <div key={id} className="flex items-center gap-1">
          <DeptSelect value={id} onChange={(v) => onChange(value.map((x) => (x === id ? (v ?? x) : x)))} />
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('移除')} onClick={() => onChange(value.filter((x) => x !== id))}>
            <IconTrash className="size-3.5" />
          </Button>
        </div>
      ))}
      <DeptSelect value={null} onChange={(v) => v && !value.includes(v) && onChange([...value, v])} />
    </div>
  )
}

export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('部门主管'), t('指定成员'), t('指定角色'), t('发起人自选'), t('表单里的人员'), t('发起人自己')]
}

/** 节点上能开关的动作（同意 / 驳回始终有）。和后端 `engine/flow.py: OPTIONAL_ACTIONS` 对应 */
const OPTIONAL_ACTIONS: [OptionalAction, string][] = [
  ['transfer', '转交'],
  ['cc', '抄送'],
  ['send_back', '退回'],
  ['add_sign', '加签'],
]

const MODE_HINT: Record<ApprovalMode, string> = {
  any: '一人同意即可，其余人的待办自动结束',
  all: '所有人都同意才通过，任何一人驳回整单结束',
  seq: '按审批人的顺序一个一个来，前一个同意了才轮到下一个',
}

export function _i18nExtractionAnchorsFlowDesigner(t: (k: string) => string) {
  return [
    t('转交'), t('抄送'), t('退回'), t('加签'),
    t('一人同意即可，其余人的待办自动结束'), t('所有人都同意才通过，任何一人驳回整单结束'),
    t('按审批人的顺序一个一个来，前一个同意了才轮到下一个'),
  ]
}

/**
 * AI 自动同意（#111 第 5 条）。🔴 开关是「允许」不是「立刻生效」：预审建议通过、而且这个流程 × 模型的「建议通过」里
 * 人最后也通过的比例够高、样本够多，才真的替人同意；永远不自动驳回。只能配在或签上、要先开 AI 预审（发布校验也拦）
 */
function AiApproveEditor({
  value, orSign, reviewOn, onChange,
}: {
  value: AiApproveConfig | null
  orSign: boolean
  reviewOn: boolean
  onChange: (v: AiApproveConfig | null) => void
}) {
  const { t } = useTranslation()
  const on = !!value?.enabled
  const blocked = !orSign ? t('只有或签节点能开') : !reviewOn ? t('先在基础信息里开 AI 预审') : null
  return (
    <Row
      label={t('AI 自动同意')}
      hint={
        on
          ? t('预审建议通过、而且数据够了才替人同意；建议驳回或拿不准，照常给人审。永远不会自动驳回')
          : (blocked ?? t('关：预审只给审批人参考'))
      }
    >
      <div className="flex flex-col gap-2" data-testid="node-ai-approve">
        <label className="flex items-center justify-between text-sm">
          {t('开启')}
          <Switch
            checked={on}
            disabled={!on && !!blocked}
            onCheckedChange={(c) =>
              onChange(c ? { enabled: true, minSamples: value?.minSamples ?? 30, minPrecision: value?.minPrecision ?? 0.95 } : null)
            }
            data-testid="node-ai-approve-switch"
          />
        </label>
        {on && value && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">{t('至少')}</span>
            <BoundedNumber
              value={value.minSamples}
              min={20}
              max={10000}
              className="h-8 w-20"
              onCommit={(minSamples) => onChange({ ...value, minSamples })}
              testId="node-ai-approve-samples"
            />
            <span className="text-muted-foreground">{t('张「建议通过」的单里，人最后也通过的不低于')}</span>
            <BoundedNumber
              value={Math.round(value.minPrecision * 100)}
              min={80}
              max={100}
              className="h-8 w-16"
              onCommit={(pct) => onChange({ ...value, minPrecision: pct / 100 })}
              testId="node-ai-approve-precision"
            />
            <span className="text-muted-foreground">%</span>
          </div>
        )}
      </div>
    </Row>
  )
}

/**
 * 有上下限的整数框。🔴 不能每敲一个键就夹到范围里：清空后打「95」，「9」先被夹成 80，再敲「5」成了「805」→ 100，
 * 门槛被静默设成了 100%。打字时只把落在范围里的值交出去，失焦再夹
 */
function BoundedNumber({
  value, min, max, className, onCommit, testId,
}: {
  value: number
  min: number
  max: number
  className?: string
  onCommit: (v: number) => void
  testId: string
}) {
  const [text, setText] = React.useState(String(value))
  const [shown, setShown] = React.useState(value)
  if (shown !== value) {
    // 外面改了（换了节点 / 重新载入）：跟着换。渲染期比对，不用 effect —— `<Activity>` 切回页签时会把 effect
    // 重建、无条件跑一次（e2e 分册「Activity 会把 effect 整个销毁重建」），会把正在打的字冲掉
    setShown(value)
    setText(String(value))
  }
  const parse = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Math.round(Number(s)))
  return (
    <Input
      type="number"
      min={min}
      max={max}
      className={className}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = parse(e.target.value)
        if (n !== null && n >= min && n <= max && n !== value) {
          setShown(n)
          onCommit(n)
        }
      }}
      onBlur={() => {
        const n = parse(text)
        const v = n === null ? value : Math.max(min, Math.min(max, n))
        setText(String(v))
        if (v !== value) {
          setShown(v)
          onCommit(v)
        }
      }}
      data-testid={testId}
    />
  )
}

/** 超时处理：关 / N 小时后提醒 · 自动同意 · 自动驳回。按自然时间算，不计工作日 */
function TimeoutEditor({
  value, onChange,
}: {
  value: { hours: number; action: 'remind' | 'approve' | 'reject' } | null
  onChange: (v: { hours: number; action: 'remind' | 'approve' | 'reject' } | null) => void
}) {
  const { t } = useTranslation()
  return (
    <Row
      label={t('超时处理')}
      hint={value ? t('从待办到这个人手上开始算，按自然时间（不计工作日）') : t('不处理：待办一直等着')}
    >
      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between text-sm">
          {t('开启')}
          <Switch
            checked={!!value}
            onCheckedChange={(on) => onChange(on ? { hours: 24, action: 'remind' } : null)}
            data-testid="node-timeout"
          />
        </label>
        {value && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Input
                type="number"
                min={1}
                max={720}
                className="h-8 w-24"
                value={value.hours}
                onChange={(e) => onChange({ ...value, hours: Math.max(1, Math.min(720, Number(e.target.value) || 1)) })}
                data-testid="node-timeout-hours"
              />
              <span className="text-muted-foreground">{t('小时没处理就')}</span>
            </div>
            <Segmented
              value={value.action}
              items={[
                { value: 'remind', label: t('提醒他') },
                { value: 'approve', label: t('自动同意') },
                { value: 'reject', label: t('自动驳回') },
              ]}
              onChange={(action) => onChange({ ...value, action })}
              testId="node-timeout-action"
            />
          </>
        )}
      </div>
    </Row>
  )
}

