import { t } from '@admin/i18n'

import type { AiTool } from './api'

/**
 * 起步提问 —— **从用户真正能调用的工具生成**，不是写死一串。
 *
 * 这么做有两个理由，都不是为了好看：
 * 1. 可发现性：不写出来，没人知道这个助手到底能干什么（它不像通用聊天框那样"什么都能问"）
 * 2. 诚实：一个没有 `sys:role:list` 的人看到的建议里就不该有"有哪些角色"——
 *    点了只会得到"你没有权限"，那是最糟的第一印象
 */
const PHRASING: Record<string, string> = {
  system_health_check: '系统现在正常吗？',
  system_whoami: '我是谁？有哪些权限？',
  role_list: '系统里有哪些角色？',
  dept_list: '部门结构是什么样的？',
  menu_list: '有哪些菜单和权限码？',
  user_list: '系统里有哪些用户？',
  login_log_list: '最近 24 小时有登录失败吗？',
  opera_log_list: '最近有哪些人改过东西？',
  weather_query: '深圳今天天气怎么样？',
}

export function buildSuggestions(tools: AiTool[] | undefined, limit = 6): string[] {
  if (!tools?.length) return []
  return tools
    // 变更类工具不做成"一键提问"：第一次用就触发一个会改数据的操作，
    // 哪怕后面有二次确认，也是个糟糕的默认
    .filter((tool) => !tool.mutating)
    .map((tool) => PHRASING[tool.name])
    .filter((q): q is string => !!q)
    .slice(0, limit)
    // 提问会原样发给模型 —— 按界面语言发，模型也按这个语言回
    .map((q) => t(q))
}
