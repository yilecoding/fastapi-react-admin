/** 开放接口调用日志（字段和操作日志同口径，另加应用维度） */
export type OpenApiLog = {
  id: string
  trace_id: string
  /** AK 无效时识别不出应用，为空 */
  app_id: string | null
  /** 调用时的快照：应用改名 / 删除后日志仍看得懂 */
  app_code: string | null
  app_name: string | null
  access_key: string | null
  method: string
  title: string
  path: string
  scope: string | null
  scope_granted: boolean | null
  ip: string
  ip_whitelisted: boolean | null
  country: string | null
  region: string | null
  city: string | null
  user_agent: string | null
  os: string | null
  browser: string | null
  device: string | null
  args: Record<string, unknown> | null
  request_headers: Record<string, string> | null
  response_headers: Record<string, string> | null
  response_body: string | null
  status: number
  code: string
  error_code: string
  msg: string | null
  row_count: number | null
  cost_time: number
  request_time: string
}

/**
 * 错误码 → 给人看的名字 + 该怎么处理。键是后端 `gateway/auth.py` 那张表里的稳定码。
 *
 * 值是中文原文（= i18n key），在渲染处 `t(…)`（模块级常量拿不到 hook，见 i18n 分册硬规则 3）。
 */
export const ERROR_META: Record<string, { label: string; hint: string }> = {
  ok: { label: '成功', hint: '' },
  'open.missing_param': { label: '缺少签名请求头', hint: '对方没带齐 X-Access-Key / X-Timestamp / X-Nonce / X-Sign 四个请求头。' },
  'open.invalid_key': {
    label: 'AK 无效',
    hint: '没有这个 Access Key（或应用已被删除）。如果来源 IP 陌生、且持续出现，像是外部探测。',
  },
  'open.app_disabled': { label: '应用已停用', hint: '应用被停用了。要恢复调用，到应用管理里重新启用。' },
  'open.app_expired': { label: '应用已过期', hint: '超过了应用的失效时间。要继续用，到应用管理里延长失效时间。' },
  'open.ip_denied': { label: 'IP 不在白名单', hint: '来源 IP 不在这个应用的白名单里。确认是对方的出口 IP 后，加进白名单。' },
  'open.timestamp_expired': {
    label: '时间戳超出窗口',
    hint: '对方的 X-Timestamp 和服务端相差超过 5 分钟。响应体里的 server_time 是服务端时间，请对方校准服务器时钟（NTP）。',
  },
  'open.sign_mismatch': {
    label: '签名不匹配',
    hint: 'AK 有效、时间戳也通过了，但对方算出的签名和服务端不一致。响应体里的 string_to_sign 是服务端拼的待签名字符串，转给对方逐行对比（常见：查询参数没排序、空格编成了 +、请求体被重新序列化）。',
  },
  'open.nonce_reused': { label: 'nonce 重复', hint: '同一个 nonce 用了两次：可能是对方重试时没换 nonce，也可能是请求被重放。' },
  'open.scope_denied': { label: '未授权该接口', hint: '签名正确，但这个应用没被授权调这个接口。需要的话到应用管理里勾上。' },
  'open.rate_limited': { label: '超过限流', hint: '超过了每分钟请求上限。对方应按响应头 Retry-After 等待；确实不够用就调高这个应用的上限。' },
  'open.bad_cursor': { label: 'cursor 无效', hint: '对方带来的 cursor 不是上一页返回的 next_cursor。' },
  'open.request_failed': { label: '请求处理失败', hint: '鉴权通过了，但接口本身报错（参数不合法或服务端异常）。看响应体和服务端日志。' },
}

/** 筛选下拉的选项（「成功」不放进来 —— 结果那一格已经有了） */
export const ERROR_OPTIONS = Object.entries(ERROR_META)
  .filter(([code]) => code !== 'ok')
  .map(([value, meta]) => ({ value, label: meta.label }))
