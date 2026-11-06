/**
 * 审批轨道：把接口数据拼成一条从「发起」到「结束」的条目列表。纯函数，不 import React / RN。
 *
 * 详情页的轨道 = 发起 + 已经发生的（按时间）+ 正在等的 + 预告（服务端试算）+ 结束。
 * 发起页的轨道 = 发起 + 预告。两边的「预告」是同一个函数转出来的，长得一样。
 *
 * 🔴 **web 和移动端共用这一份**（#257）。原来移动端 `lib/workflow-progress.ts` 是 web `progress.ts` 的移植，
 * 注释里写着「web 那份改了这里跟着改」，没有任何东西核对。进度怎么分步（按「节点 + 轮次」分组、退回后重走是新的一步、
 * AI 自动同意画成「没经手」不画成「已同意」……）是 web 那边踩出来的，见 `pages/workflow` 分册；
 * 两端的进度长得不一样，审批人会以为其中一边坏了。
 *
 * 入参只声明**这里读的字段**（`ProgressDetail`），两端各自的 `InstanceDetail` 结构上满足它就能传 ——
 * 哪一端的类型漂了，编译器在调用处报。
 *
 * 文案的 key 写在这里（`t('…')`），两端注入各自的 `t`；本包不依赖 i18n，时间格式化同样是注入的。
 */

type T = (k: string, o?: Record<string, unknown>) => string

export type Tone = 'ok' | 'bad' | 'muted' | 'pending'

export type TrackPerson = {
  name: string
  /** 这个人在这一步的结果，显示在名字后面 */
  result?: { text: string; tone: Tone }
  time?: string | null
  opinion?: string | null
}

export type TrackState = 'done' | 'current' | 'rejected' | 'future' | 'skipped' | 'warn' | 'withdrawn'

export type TrackItem = {
  key: string
  kind: 'start' | 'approval' | 'cc' | 'system' | 'end'
  title: string
  /** 标题后的小字：会签 / 或签 / 自动跳过 / 发起人自选… */
  tag?: string
  state: TrackState
  people?: TrackPerson[]
  /** 没有人可显示时的一句话（「找不到审批人，将自动驳回」） */
  note?: string
  time?: string | null
}

/**
 * 预告是说给谁听的。两种读者看到的是同一份试算，要的话不一样：
 *
 * - `starter`：正在填单 / 被退回来改的发起人 —— 审批人选择就在轨道上面，「发起人自选」那一步要**叫他去选**，
 *   「找不到审批人」那一步要告诉他**提交后**会被驳回
 * - `viewer`：其他人看一张已经在走的单 —— 叫审批人「在上面选」读不通，换成陈述句
 *
 * 🔴 #257 第 3 条：移动端原来只有 `viewer` 这一种（照详情页改的），发起页也用它，发起人自己看到的是
 * 「发起人还没选审批人」「到这一步会被自动驳回」，不知道那是在说他、也不知道要做什么。
 */
export type ForecastAudience = 'starter' | 'viewer'

// ── 入参：只声明这里读的字段 ──────────────────────────────────────────────────

export type ProgressForecastStep = {
  node_id: string
  name: string
  type: 'approval' | 'cc'
  mode: string
  users: { name: string }[]
  /** ok 有人办 · pick 发起人自选还没选 · skip 跳过 · admin 转给管理员 · reject 将被自动驳回 */
  outcome: 'ok' | 'pick' | 'skip' | 'admin' | 'reject'
  /** 办理人来自查看人看不到的人员字段：服务端不给名字 */
  masked?: boolean
}

export type ProgressTask = {
  id: string
  node_id: string
  node_name: string
  assignee_name: string
  /** 第几轮进入这个节点：退回之后重走同一个节点时不同 */
  batch: number
  due_time?: string | null
  read_time?: string | null
  status: 'pending' | 'done' | 'canceled' | 'transferred'
  decision: string | null
  opinion: string | null
  created_time: string
  finished_time: string | null
}

export type ProgressRecord = {
  id: string
  task_id: string | null
  action: string
  actor_type: string
  actor_name: string | null
  node_id: string | null
  node_name: string | null
  target_user_name: string | null
  opinion: string | null
  detail: { to_name?: string; mode?: string } | null
  created_time: string
}

export type ProgressDetail = {
  instance: { initiator_name: string | null; status: string; created_time: string; finished_time: string | null }
  /** 流程树：按节点 ID 找审批方式（或签 / 会签 / 依次）和超时动作 */
  model: { root: { id: string } }
  tasks: readonly ProgressTask[]
  records: readonly ProgressRecord[]
  waiting: readonly { name: string | null; masked?: boolean }[]
  forecast: readonly ProgressForecastStep[]
}

export type ProgressOptions = {
  audience: ForecastAudience
  /** 超时提示里的时间（两端各自的 `formatDateTime`，跟着用户时区走） */
  formatTime: (iso: string) => string
}

// ── 轨道 ─────────────────────────────────────────────────────────────────────

const DECISION: Record<string, { text: string; tone: Tone }> = {
  approve: { text: '已同意', tone: 'ok' },
  reject: { text: '已驳回', tone: 'bad' },
  transferred: { text: '已转交', tone: 'muted' },
  canceled: { text: '无需处理', tone: 'muted' },
  pending: { text: '审批中', tone: 'pending' },
  send_back: { text: '已退回', tone: 'bad' },
  resubmit: { text: '已重新提交', tone: 'ok' },
  add_sign: { text: '已加签', tone: 'muted' },
  take_back: { text: '已拿回', tone: 'muted' },
}

function modeTag(mode: string | undefined, count: number, t: T): string | undefined {
  if (count < 2) return undefined
  if (mode === 'seq') return t('依次审批 · 按顺序逐个同意')
  return mode === 'all' ? t('会签 · 需全部同意') : t('或签 · 一人同意即可')
}

/** 预告步骤 → 轨道条目 */
export function forecastItems(steps: readonly ProgressForecastStep[], t: T, audience: ForecastAudience): TrackItem[] {
  const starter = audience === 'starter'
  return steps.map((s) => {
    const people = s.users.map((u) => ({ name: u.name }))
    if (s.type === 'cc') {
      return {
        key: `f-${s.node_id}`,
        kind: 'cc',
        title: s.name || t('抄送'),
        state: s.users.length ? 'future' : 'skipped',
        people,
        note: s.users.length ? undefined : t('没有要抄送的人'),
      } satisfies TrackItem
    }
    const base = { key: `f-${s.node_id}`, kind: 'approval' as const, title: s.name, people }
    switch (s.outcome) {
      case 'pick':
        return { ...base, state: 'warn', note: starter ? t('请在上面选择审批人') : t('发起人还没选审批人') }
      case 'skip':
        return { ...base, state: 'skipped', tag: t('自动跳过'), note: t('找不到审批人，这一步会自动跳过') }
      case 'admin':
        return { ...base, state: 'future', tag: t('转给管理员'), note: t('找不到对应的审批人，转给管理员处理') }
      case 'reject':
        return {
          ...base,
          state: 'warn',
          note: starter ? t('找不到审批人，提交后会被自动驳回') : t('找不到审批人，到这一步会被自动驳回'),
        }
      default:
        if (s.masked) return { ...base, state: 'future', note: t('由申请内容里的人员决定') }
        return { ...base, state: 'future', tag: modeTag(s.mode, s.users.length, t) }
    }
  })
}

/** 详情 → 完整的审批进度 */
export function progressItems(d: ProgressDetail, t: T, opts: ProgressOptions): TrackItem[] {
  const items: (TrackItem & { at: number })[] = []
  const ts = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0)

  items.push({
    key: 'start',
    kind: 'start',
    title: t('发起申请'),
    state: 'done',
    people: [{ name: d.instance.initiator_name ?? '—' }],
    time: d.instance.created_time,
    at: ts(d.instance.created_time) - 1,
  })

  // 待办按「节点 + 轮次」分组：同一次进入这个节点（含转交出来的、依次审批轮到的）是一步；
  // 退回之后重走同一个节点是新的一步（`batch` 不同）—— 不分的话两轮的人挤在同一步里
  const groups = new Map<string, ProgressTask[]>()
  for (const tk of d.tasks) {
    const k = `${tk.node_id}:${tk.batch}`
    groups.set(k, [...(groups.get(k) ?? []), tk])
  }
  const byTask = new Map(d.records.filter((r) => r.task_id).map((r) => [r.task_id as string, r]))
  const atStart = (nodeId: string) => nodeId === d.model.root.id
  for (const [k, tasks] of groups) {
    const nodeId = tasks[0].node_id
    const pending = tasks.some((x) => x.status === 'pending')
    // 整步的待办都被作废了（上一步拿回 / 被退回）：这一步等于没发生过
    const voided = tasks.every((x) => x.status === 'canceled')
    const rejected = tasks.some((x) => x.decision === 'reject')
    const lastDone = tasks
      .filter((x) => x.finished_time)
      .map((x) => x.finished_time as string)
      .sort()
      .pop()
    const mode = findMode(d, nodeId)
    const current = pending && d.instance.status === 'running'
    // 依次审批：后面还没轮到的人也列在这一步里，标「等待中」
    const waiting = current && mode === 'seq' ? d.waiting : []
    const masked = waiting.some((w) => w.masked)
    const people: TrackPerson[] = tasks.map((tk) => {
      const key = tk.status === 'done' ? (tk.decision ?? 'approve') : tk.status
      const meta = DECISION[key] ?? DECISION.pending
      const rec = byTask.get(tk.id)
      // 还在办的：写上他打开看过没有 —— 「他看过了还没批」和「他根本没看到」是两回事
      let text = tk.status === 'pending' ? (tk.read_time ? t('审批中 · 已读') : t('审批中 · 未读')) : t(meta.text)
      if (tk.status === 'transferred' && rec?.target_user_name) {
        text =
          rec.action === 'reassign'
            ? t('管理员改给 {{n}}', { n: rec.target_user_name })
            : t('转交给 {{n}}', { n: rec.target_user_name })
      } else if (tk.decision === 'send_back' && rec?.detail?.to_name) {
        text = t('退回给 {{n}}', { n: rec.detail.to_name })
      } else if (rec?.action === 'add_sign' && rec.target_user_name && tk.decision !== 'take_back') {
        // 在我之前：这一票还没投，先请他们审；在我之后：这一票是同意，再请他们审
        text =
          rec.detail?.mode === 'after'
            ? t('同意并加签给 {{n}}', { n: rec.target_user_name })
            : t('加签给 {{n}}，等他们审完', { n: rec.target_user_name })
      }
      // 还在办、节点配了超时：写明什么时候会被提醒 / 自动处理（不写的话「突然被自动同意了」没人看得懂）
      const due =
        tk.status === 'pending' && tk.due_time ? dueNote(opts.formatTime(tk.due_time), findTimeout(d, tk.node_id), t) : undefined
      return { name: tk.assignee_name, result: { text, tone: meta.tone }, time: tk.finished_time, opinion: tk.opinion ?? due }
    })
    if (!masked) {
      for (const w of waiting) people.push({ name: w.name ?? '', result: { text: t('等待中'), tone: 'muted' } })
    }
    // AI 自动同意（#111 第 5 条）：这一步人的待办都取消了、记录在节点上。画成一步「AI 自动同意」，人那一栏写「没经手」——
    // 🔴 不能画成「张三 已同意」：他没同意过；也不能画成「已跳过」：这一步是被同意了的
    const byAi = voided
      ? d.records.find(
          (r) => r.action === 'ai_approve' && r.node_id === nodeId && ts(r.created_time) >= ts(tasks[0].created_time),
        )
      : undefined
    if (byAi) {
      items.push({
        key: `n-${k}`,
        kind: 'approval',
        title: tasks[0].node_name,
        tag: t('AI 自动同意'),
        state: 'done',
        people: tasks.map((tk) => ({ name: tk.assignee_name, result: { text: t('没经手'), tone: 'muted' as const } })),
        note: `${byAi.actor_name ?? 'AI'}：${byAi.opinion ?? ''}`,
        time: byAi.created_time,
        at: ts(tasks[0].created_time),
      })
      continue
    }
    items.push({
      key: `n-${k}`,
      kind: atStart(nodeId) ? 'start' : 'approval',
      title: tasks[0].node_name,
      tag: modeTag(mode, tasks.filter((x) => x.status !== 'transferred').length + waiting.length, t),
      state: rejected ? 'rejected' : pending ? (current ? 'current' : 'skipped') : voided ? 'skipped' : 'done',
      people,
      note: masked ? t('后面还有人，由申请内容里的人员决定') : undefined,
      time: pending ? null : lastDone,
      at: ts(tasks[0].created_time),
    })
  }

  for (const r of d.records) {
    if (r.action === 'skip') {
      items.push({
        key: `r-${r.id}`, kind: 'system', title: r.node_name ?? t('审批'), tag: t('自动跳过'),
        state: 'skipped', note: r.opinion ?? undefined, time: r.created_time, at: ts(r.created_time),
      })
    } else if (r.action === 'resume') {
      items.push({
        key: `r-${r.id}`, kind: 'system', title: t('直接回到「{{n}}」', { n: r.detail?.to_name ?? '' }),
        state: 'done', note: t('退回时选了重新处理后直接回到这一步，中间的步骤不再审'),
        time: r.created_time, at: ts(r.created_time),
      })
    } else if (r.action === 'auto_reject') {
      items.push({
        key: `r-${r.id}`, kind: 'system', title: r.node_name ?? t('审批'), tag: t('自动驳回'),
        state: 'rejected', note: r.opinion ?? undefined, time: r.created_time, at: ts(r.created_time),
      })
    } else if (r.action === 'cc') {
      items.push({
        key: `r-${r.id}`, kind: 'cc',
        title: r.actor_type === 'system' ? (r.node_name ?? t('抄送')) : t('{{n}} 抄送了', { n: r.actor_name }),
        state: 'done', people: (r.target_user_name ?? '').split('、').filter(Boolean).map((name) => ({ name })),
        time: r.created_time, at: ts(r.created_time),
      })
    } else if (r.action === 'withdraw' || r.action === 'terminate') {
      items.push({
        key: `r-${r.id}`, kind: 'system', title: r.action === 'withdraw' ? t('发起人撤回') : t('管理员终止'),
        state: r.action === 'withdraw' ? 'withdrawn' : 'rejected',
        people: [{ name: r.actor_name ?? '—', opinion: r.opinion }],
        time: r.created_time, at: ts(r.created_time),
      })
    }
  }

  items.sort((a, b) => a.at - b.at)
  const out: TrackItem[] = items.map(({ at: _at, ...rest }) => rest)

  const status = d.instance.status
  if (status === 'running') out.push(...forecastItems(d.forecast, t, opts.audience))
  out.push({
    key: 'end',
    kind: 'end',
    title: t(END_TEXT[status] ?? '结束'),
    state: status === 'approved' ? 'done' : status === 'running' ? 'future' : status === 'withdrawn' ? 'withdrawn' : 'rejected',
    time: d.instance.finished_time,
  })
  return out
}

const END_TEXT: Record<string, string> = {
  approved: '审批通过', rejected: '审批驳回', withdrawn: '已撤回', terminated: '已终止', running: '结束',
}

/** 在流程树里按节点 ID 找一个属性（树的形状两端都不细声明，这里按对象深搜） */
function findInModel(d: ProgressDetail, nodeId: string, pick: (o: Record<string, unknown>) => string | undefined) {
  let found: string | undefined
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object' || found) return
    const o = n as Record<string, unknown>
    if (o.id === nodeId) found = pick(o)
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v)
  }
  visit(d.model.root)
  return found
}

const findMode = (d: ProgressDetail, nodeId: string) =>
  findInModel(d, nodeId, (o) => (typeof o.mode === 'string' ? o.mode : undefined))

const findTimeout = (d: ProgressDetail, nodeId: string) =>
  findInModel(d, nodeId, (o) => (o.timeout as { action?: string } | undefined)?.action)

function dueNote(at: string, action: string | undefined, t: T): string | undefined {
  if (action === 'approve') return t('{{at}} 前未处理将自动同意', { at })
  if (action === 'reject') return t('{{at}} 前未处理将自动驳回', { at })
  if (action === 'remind') return t('{{at}} 起会收到超时提醒', { at })
  return undefined
}

/** 上面 `t(meta.text)` / `t(END_TEXT[…])` 是变量，抽取器看不见 —— 在这里写一遍字面量 */
export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [
    t('已同意'), t('已驳回'), t('已转交'), t('无需处理'), t('审批中'), t('审批通过'), t('审批驳回'), t('已撤回'),
    t('已终止'), t('结束'), t('已退回'), t('已重新提交'), t('已加签'), t('已拿回'),
  ]
}
