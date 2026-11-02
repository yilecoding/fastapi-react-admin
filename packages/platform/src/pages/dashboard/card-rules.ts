/**
 * 卡片里那几处「拿接口数据算出一句话 / 一个数 / 一个去处」的纯逻辑（单测 `card-rules.test.ts`）。
 * 不 import React，也不 import 运行时的接口客户端 —— 渲染层走 E2E，这里要的是「规则改坏了没有」这个信号。
 */
import { formatDateTimeShort } from '@admin/i18n'

import type { AttentionItem, DeskTodoPage, InitiatedRow } from './api'

/** 普通函数里用的 `t` 签名（同 `cards/types.ts`） */
type TFn = (key: string, vars?: Record<string, unknown>) => string

/**
 * 已结束的单最后一步那句话：「10-28 赵磊 同意：「注意交接」」。
 * 每种动作一条完整的句子 key —— 拼「{{action}}」的话英文语序和标点都对不上。
 *
 * 🔴 动作名照**引擎实际记的**写：超时自动处理是 `timeout_approve` / `timeout_reject`（`runtime_service.apply_timeout`），
 * 没有 `auto_approve` 这个名字。认不出来就落进「处理」那一支 —— 最后一个节点超时自动驳回时，原来显示的是上一个人的「同意」
 * （后端也漏认了那两个名字，见 workflow 分册）。系统做的动作 `actor_name` 是空的，说「超时自动…」，不写一个「—」
 */
export function lastLine(last: NonNullable<InitiatedRow['last']>, t: TFn): string {
  const v = { at: formatDateTimeShort(last.time), who: last.actor_name ?? '—', opinion: last.opinion }
  const said = Boolean(last.opinion)
  switch (last.action) {
    case 'timeout_approve':
      return t('{{at}} 超时自动同意', v)
    case 'timeout_reject':
      return t('{{at}} 超时自动驳回', v)
    case 'ai_approve':
      return t('{{at}} AI 自动同意', v)
    case 'auto_reject':
      // 节点取不到审批人，按配置自动驳回（意见是引擎写的原因）
      return said ? t('{{at}} 自动驳回：「{{opinion}}」', v) : t('{{at}} 自动驳回', v)
    case 'approve':
      return said ? t('{{at}} {{who}} 同意：「{{opinion}}」', v) : t('{{at}} {{who}} 同意', v)
    case 'reject':
      return said ? t('{{at}} {{who}} 驳回：「{{opinion}}」', v) : t('{{at}} {{who}} 驳回', v)
    case 'withdraw':
      return t('{{at}} {{who}} 撤回了这张单', v)
    case 'terminate':
      return said ? t('{{at}} {{who}} 终止：「{{opinion}}」', v) : t('{{at}} {{who}} 终止', v)
    default:
      return said ? t('{{at}} {{who}} 处理：「{{opinion}}」', v) : t('{{at}} {{who}} 处理', v)
  }
}

export type TodoCounts = { total: number; urgent: number; back: number; approve: number }

/**
 * 「待我处理」的几个数：大标题的 N / M、分段上的数字。
 *
 * 🔴 **一律用后端给的全量数**（`total` / `urgent_total` / `returned_total`），不从取回来的那一页里数：
 * 工作台只取前 `DESK_TODO_SIZE` 条，80 件里 60 件加急时数这一页只有 50。
 * 老后端没给这两个字段时才退回数这一页（桌面端 / 移动端会拿新前端配旧后端吗？不会 —— 只是不让它算出 `undefined`）
 */
export function todoCounts(page: DeskTodoPage): TodoCounts {
  const urgent = page.urgent_total ?? page.items.filter((r) => r.urgent).length
  const back = page.returned_total ?? page.items.filter((r) => r.back).length
  return { total: page.total, urgent, back, approve: Math.max(0, page.total - back) }
}

export type AttentionLink =
  | { to: '/open/app'; search: { webhook: string; wtab: 'endpoints' }; label: string }
  | { to: '/scheduler/record'; search: { name?: string; status: 'FAILURE' }; label: string }
  | { to: '/log/login'; search: { status: 0; time: string }; label: string }

/**
 * 「需要你留意」每一条的按钮：去哪、带什么参数。**按目标页的路由守卫给**，进不去的不给按钮。
 *
 * ⚠️ 任务名可能是空的（celery 没记上名字的那种失败）：`search={{ name: null }}` 进地址栏是 `name=null`，
 * 执行记录页的 `name: z.string().optional()` 校验不过，整页报错 —— 没有名字就不带这个参数
 */
export function attentionLink(
  item: AttentionItem,
  can: (perm: string) => boolean,
  todayRange: string,
  t: TFn
): AttentionLink | null {
  switch (item.kind) {
    case 'webhook_disabled':
      return can('open:app:list')
        ? { to: '/open/app', search: { webhook: item.app_id, wtab: 'endpoints' }, label: t('去处理') }
        : null
    case 'task_failed':
      // 执行记录页只要登录（route 文件里写了为什么）
      return {
        to: '/scheduler/record',
        search: item.task ? { name: item.task, status: 'FAILURE' } : { status: 'FAILURE' },
        label: t('看记录'),
      }
    case 'login_fail_spike':
      return can('log:login:del') ? { to: '/log/login', search: { status: 0, time: todayRange }, label: t('看明细') } : null
  }
}
