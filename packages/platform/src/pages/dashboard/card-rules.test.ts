import { describe, expect, it } from 'vitest'

import type { AttentionItem, DeskTodoPage, DeskTodoRow, InitiatedRow } from './api'
import { attentionLink, lastLine, todoCounts } from './card-rules'

/** 把 `{{x}}` 换成值，看得出走的是哪一句 */
const t = (key: string, vars?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars?.[k] ?? ''))

const last = (
  action: string,
  actor_name: string | null = null,
  opinion: string | null = null
): NonNullable<InitiatedRow['last']> => ({ action, actor_name, opinion, time: '2026-10-28T14:00:00+08:00' })

describe('lastLine（我发起的：最后一步那句话）', () => {
  it('🔴 超时自动驳回 / 同意按引擎记的动作名认，不落进「处理」、不写「—」', () => {
    expect(lastLine(last('timeout_reject', null, '超过 2 小时未处理，自动驳回'), t)).toMatch(/超时自动驳回$/)
    expect(lastLine(last('timeout_approve'), t)).toMatch(/超时自动同意$/)
    expect(lastLine(last('timeout_reject'), t)).not.toContain('—')
  })

  it('人做的同意 / 驳回带名字和意见', () => {
    expect(lastLine(last('approve', '赵磊', '注意交接'), t)).toMatch(/赵磊 同意：「注意交接」$/)
    expect(lastLine(last('reject', '赵磊'), t)).toMatch(/赵磊 驳回$/)
  })

  it('AI 自动同意 / 取不到人自动驳回各说各的', () => {
    expect(lastLine(last('ai_approve', 'qwen3-vl'), t)).toMatch(/AI 自动同意$/)
    expect(lastLine(last('auto_reject', null, '没有审批人'), t)).toMatch(/自动驳回：「没有审批人」$/)
  })
})

const row = (o: Partial<DeskTodoRow>) => ({ urgent: false, back: false, ...o }) as DeskTodoRow
const page = (o: Partial<DeskTodoPage>): DeskTodoPage =>
  ({ items: [], total: 0, page: 1, size: 50, total_pages: 1, links: {}, ...o }) as unknown as DeskTodoPage

describe('todoCounts（大标题 / 分段的数）', () => {
  it('🔴 加急 / 退回给我用后端的全量数，不从取回来的那一页里数', () => {
    // 80 件里 60 件加急、3 件退回，这一页只取回 2 条
    const p = page({ total: 80, urgent_total: 60, returned_total: 3, items: [row({ urgent: true }), row({ back: true })] })
    expect(todoCounts(p)).toEqual({ total: 80, urgent: 60, back: 3, approve: 77 })
  })

  it('老后端没给全量数时退回数这一页', () => {
    const p = page({ total: 2, items: [row({ urgent: true }), row({ back: true })] })
    expect(todoCounts(p)).toEqual({ total: 2, urgent: 1, back: 1, approve: 1 })
  })
})

const task = (name: string | null): AttentionItem => ({
  kind: 'task_failed',
  level: 'warning',
  task: name,
  name: name ?? '—',
  count: 1,
  time: null,
  error: null,
})

describe('attentionLink（需要你留意的按钮）', () => {
  const all = () => true
  const none = () => false

  it('🔴 任务名为空时不带 name —— 带 `name: null` 进地址栏是 `name=null`，执行记录页整页校验不过', () => {
    const link = attentionLink(task(null), all, '2026-11-01~2026-11-01', t)
    expect(link?.to).toBe('/scheduler/record')
    expect(link?.search).toEqual({ status: 'FAILURE' })
    expect(attentionLink(task('maintenance.prune_logs'), all, '', t)?.search).toEqual({
      name: 'maintenance.prune_logs',
      status: 'FAILURE',
    })
  })

  it('按目标页的路由守卫给：进不去的不给按钮', () => {
    const spike: AttentionItem = {
      kind: 'login_fail_spike',
      level: 'warning',
      day: '2026-11-01',
      count: 9,
      avg: 1,
      top_ip: null,
      top_ip_count: 0,
    }
    expect(attentionLink(spike, none, 'x', t)).toBeNull()
    expect(attentionLink(spike, (p) => p === 'log:login:del', '2026-11-01~2026-11-01', t)?.search).toEqual({
      status: 0,
      time: '2026-11-01~2026-11-01',
    })
  })
})
