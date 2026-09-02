import { ApiError, type Envelope, isEnvelope } from './errors'

/**
 * 🔴 **信封里只有 `code === 200` 算成功。HTTP 状态码不足以判断成败。**
 *
 * `backend/common/response/response_schema.py` 的 `response_base.fail()`
 * 返回的是 **HTTP 200 + `code: 400`**。后端只用三个信封码：
 * `200`（成功）/ `400`（失败）/ `500`（服务端错误），加上 `40001` 那类业务码
 * （它们经 `_get_exception_code` 降级后配的是 HTTP 400）。
 *
 * 客户端只看 `!res.ok` 的话，所有 `fail()` 都会被读成成功 —— 而 `fail()`
 * 是**全站写接口的通用失败出口**（`count > 0 ? success() : fail()` 这个形状
 * 在 handler 里到处都是）。
 *
 * ⚠️ **一条需要纠正的说法**：这里原来写着「设一个和库里一样的值 → 0 行 →
 * fail()」，并说界面上表现为「保存成功、页面退回、值没变」。**在 SQL Server
 * 上那是错的** —— `rowcount` 数的是**匹配**行而不是**变更**行，设同值照样
 * 返回 `code: 200`（`backend/app/admin/tests/api_v1/test_me_envelope.py`
 * 实测钉住了）。那个说法只在 **MySQL** 上成立（asyncmy 默认报变更行，
 * 而本仓库没有设 `CLIENT_FOUND_ROWS`）—— 也就是说**同一个接口在三个方言上
 * 行为不同**。
 *
 * 判定本身不受影响：`fail()` 该当成失败，无论它因为什么原因发生。
 *
 * web 端的 `packages/platform` 当初也是同一个洞。所以这个判断收进这个包，
 * **两端共用一份**，不要在客户端里各写一遍。
 */
const SUCCESS_CODE = 200

/** 网络层没走通（连不上 / DNS / TLS）时用的 httpStatus，见 `ApiError.isNetwork` */
export const NETWORK_STATUS = 0

export type EnvelopeResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

/**
 * 把一次响应判定成成败，并拆掉 `{code,msg,data}` 包封。
 *
 * **这是一个纯判定函数，不碰 401 刷新。** 刷新在 `client.ts` 的
 * `createApiClient` 里集中做（单飞 + 重放一次），**两端共用同一份** ——
 * 调用方不需要自己判 `isUnauthorized`。
 * 拆开的理由是职责：这里只回答「这次响应算成功还是失败」，
 * 而刷新要访问注入进来的 token 存储、还要能重放请求。
 *
 * @param res    只用到 `ok` / `status` / `statusText`，所以 openapi-fetch 的
 *               响应和裸 `fetch` 的响应都能传
 * @param body   已经解析好的 JSON（解析失败传 `null`，比如反代返回的 HTML 错误页）
 */
export function resolveEnvelope<T>(
  res: { ok: boolean; status: number; statusText: string },
  body: unknown,
): EnvelopeResult<T> {
  const envelope: Envelope<unknown> | null = isEnvelope(body) ? body : null

  // HTTP 层失败
  if (!res.ok) {
    return {
      ok: false,
      error: new ApiError(
        res.status,
        envelope?.code ?? res.status,
        envelope?.msg ?? (res.statusText || `HTTP ${res.status}`),
        envelope?.data ?? body,
      ),
    }
  }

  // 🔴 HTTP 200 但信封说失败 —— 就是上面注释里那个坑
  if (envelope && envelope.code !== SUCCESS_CODE) {
    return {
      ok: false,
      error: new ApiError(res.status, envelope.code, envelope.msg, envelope.data),
    }
  }

  // 没有信封的情况（空 body、或者压根不是 FBA 的响应）原样返回
  return { ok: true, data: (envelope ? envelope.data : body) as T }
}
