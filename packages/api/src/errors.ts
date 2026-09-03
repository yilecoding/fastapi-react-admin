/**
 * FBA 的错误契约有个陷阱：
 *
 * `backend/common/exception/exception_handler.py:_get_exception_code` 会把
 * **非法 HTTP 状态码降级成 400**。所以像 `CAPTCHA_ERROR = (40001, ...)` 这样的业务码，
 * 客户端收到的是 `HTTP 400` + body `{code: 40001, msg: "..."}`。
 *
 * 结论：判断错误必须同时看 httpStatus 和 bizCode，只看其一会漏。
 */
export class ApiError extends Error {
  readonly httpStatus: number
  readonly bizCode: number
  readonly detail: unknown

  constructor(httpStatus: number, bizCode: number, msg: string, detail?: unknown) {
    super(msg)
    this.name = 'ApiError'
    this.httpStatus = httpStatus
    this.bizCode = bizCode
    this.detail = detail
  }

  /** 未认证 / token 失效 */
  get isUnauthorized() {
    return this.httpStatus === 401
  }

  /** 已认证但无权限 */
  get isForbidden() {
    return this.httpStatus === 403
  }

  /** 参数校验失败 */
  get isValidation() {
    return this.httpStatus === 422 || this.bizCode === 422
  }

  /** 命中限流（429） */
  get isRateLimited() {
    return this.httpStatus === 429
  }

  /**
   * 网络层就没走通（连不上 / DNS / TLS），**不是**服务端返回的错误。
   * 客户端构造时用 `httpStatus = 0` 表示这一类。
   */
  get isNetwork() {
    return this.httpStatus === 0
  }
}

/** FBA 统一响应包封 */
export type Envelope<T> = { code: number; msg: string; data: T }

export function isEnvelope(v: unknown): v is Envelope<unknown> {
  return typeof v === 'object' && v !== null && 'code' in v && 'msg' in v
}
