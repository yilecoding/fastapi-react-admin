import { describe, expect, it } from 'vitest'

import { forecastItems, progressItems, type ProgressDetail, type ProgressForecastStep } from './workflow-progress'

/** 原样返回 key、把 {{n}} 填进去 —— 断言写中文 key，和语言包无关 */
const t = (k: string, o?: Record<string, unknown>) => k.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(o?.[n] ?? ''))

const step = (o: Partial<ProgressForecastStep>): ProgressForecastStep => ({
  node_id: 'n1', name: '直属主管', type: 'approval', mode: 'or', users: [], outcome: 'ok', ...o,
})

describe('forecastItems：预告说给谁听（#257 第 3 条）', () => {
  it('发起人：叫他去选审批人、告诉他提交后会被驳回', () => {
    const [pick, reject] = forecastItems([step({ outcome: 'pick' }), step({ node_id: 'n2', outcome: 'reject' })], t, 'starter')
    expect(pick.note).toBe('请在上面选择审批人')
    expect(reject.note).toBe('找不到审批人，提交后会被自动驳回')
  })

  it('其他人看一张在走的单：陈述句', () => {
    const [pick, reject] = forecastItems([step({ outcome: 'pick' }), step({ node_id: 'n2', outcome: 'reject' })], t, 'viewer')
    expect(pick.note).toBe('发起人还没选审批人')
    expect(reject.note).toBe('找不到审批人，到这一步会被自动驳回')
  })
})

describe('progressItems', () => {
  const detail = (o: Partial<ProgressDetail> = {}): ProgressDetail => ({
    instance: { initiator_name: '张三', status: 'running', created_time: '2026-11-06T01:00:00Z', finished_time: null },
    model: { root: { id: 'root', children: [{ id: 'n1', mode: 'or', timeout: { action: 'approve' } }] } as { id: string } },
    tasks: [],
    records: [],
    waiting: [],
    forecast: [],
    ...o,
  })

  it('把 audience 传给预告', () => {
    const d = detail({ forecast: [step({ outcome: 'pick' })] })
    const items = progressItems(d, t, { audience: 'viewer', formatTime: (s) => s })
    expect(items.map((x) => x.key)).toEqual(['start', 'f-n1', 'end'])
    expect(items[1].note).toBe('发起人还没选审批人')
  })

  it('超时提示用注入的时间格式化', () => {
    const d = detail({
      tasks: [{
        id: 't1', node_id: 'n1', node_name: '直属主管', assignee_name: '李四', batch: 1, due_time: '2026-11-07T01:00:00Z',
        status: 'pending', decision: null, opinion: null, created_time: '2026-11-06T01:00:01Z', finished_time: null,
      }],
    })
    const items = progressItems(d, t, { audience: 'viewer', formatTime: () => '明天 09:00' })
    expect(items[1].people?.[0].opinion).toBe('明天 09:00 前未处理将自动同意')
  })
})
