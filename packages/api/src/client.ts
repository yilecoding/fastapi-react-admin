import createOpenApiClient from 'openapi-fetch'

/*
 * 🔴 **从叶子模块直接取，不要 import 自己的 barrel（`./index`）。**
 *
 * 这里原来写的是 `from './index'`，而 `index.ts` 又 `export { createApiClient }
 * from './client'` —— 一个环。Metro 会打出
 * `Require cycle: packages/api/src/index.ts -> packages/api/src/client.ts -> ...`
 * （**只有 Metro 打**：Vite / tsc / eslint 全都不说话，所以 web 端跑了很久都没人发现，
 * 是移动端在设备上跑起来才现形的）。
 *
 * 现在能跑是因为这三个绑定都只在**函数体里**用；一旦有人在模块作用域用它们
 * （`const E = new ApiError(...)`、或者给默认参数），环里后加载的那一侧会拿到
 * `undefined` —— 报的是 `undefined is not a constructor` 之类，和真因隔着两层。
 */
import { ApiError } from './errors'
import { NETWORK_STATUS, resolveEnvelope } from './envelope'
import type { ApiMethods } from './types'

/**
 * 两端共用的一份 API 客户端。
 *
 * 🔴 **平台差异全部走注入，不在这里 `if (platform)`。** 以前 web 和 mobile
 * 各有一份手写客户端，代价是实测出来的：「HTTP 200 + `code: 400` 被当成成功」
 * 那个坑**两端各有一份**（见 `envelope.ts`），改一边不会修另一边。
 *
 * 底座是 `openapi-fetch`（第三方，`openapi-ts` 那一套）—— 核过它只用
 * `fetch` / `Request` / `Response` / `Headers` / `URLSearchParams`，
 * **`new URL()` 用了 0 次**（拼地址是字符串拼接，见其 `createFinalURL`）。
 * 所以它在 React Native 上一样能跑 —— RN 的 `URL` 是个不完整 shim 这件事
 * 不影响它。移动端一开始没用它，唯一的原因是 `schema.d.ts` 当时住在
 * `packages/platform` 里、而移动端不能依赖那个包（它是 web 形状的：
 * TanStack Router / react-dom / zustand）。契约搬到本包之后这个理由就没了。
 */
export type ApiClientConfig = {
  /**
   * 🔴 **每次请求现取，不是构造时定死。**
   *
   * 移动端可以在「设置 → 服务器」里改地址（`EXPO_PUBLIC_*` 是构建期替换的
   * 字符串常量，打进 APK 之后就焊死了），所以这里必须是函数。
   */
  getBaseUrl: () => string

  /**
   * 🔴 **同步读。** 每个请求都要拿 token，异步读会把「有没有登录」变成一件
   * 异步的事、UI 会闪一下未登录态。异步存储（`expo-secure-store`）要在启动时
   * hydrate 进内存、这里读内存那一份 —— 移动端 `token-store.ts` 就是这么做的。
   */
  getToken: () => string | null
  setToken: (token: string) => void | Promise<void>
  clearToken: () => void | Promise<void>

  /**
   * 界面语言，发成 `Accept-Language`。
   *
   * ⚠️ **必须跟界面语言同步，不能写死。** 后端 `middleware/i18n_middleware.py`
   * 按这个头切响应 `msg`，实测后果：
   *   - 语言不同步 → 中文界面里混进英文接口消息
   *   - 未映射的语言（日文/法文…）→ `I18n.t()` 走 KeyError 分支，**所有** msg
   *     都变成「当前语言包未初始化或不存在」，错误提示全废
   *
   * 做成注入而不是直接 import `@admin/i18n`：本包要保持零 workspace 依赖。
   */
  getLanguage: () => string

  /** 刷新也救不回来时的收尾（清状态 + 跳登录页）。由各端 auth 层注入 */
  onSessionExpired?: () => void

  /**
   * 网络层失败（连不上 / DNS / TLS）时加工一下错误再抛。
   *
   * ⚠️ **做成注入而不是在调用点包一层**：包一层就要写一个
   * `async function wrap(p) { try { return await p } catch … }`，
   * 而**再包一层函数会把泛型全部擦掉** —— 那正是这次要打开的那套推断。
   * 移动端用它把地址和原因翻成界面语言（RN 只给一句
   * `Network request failed`，不说是哪一种，而地址是用户自己能改的）。
   */
  onNetworkError?: (error: ApiError) => ApiError
}

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/**
 * 🔴 **`Paths` 就是生成的 `schema.d.ts` 里那个 `paths`。**
 * 路径、查询参数名、请求体、返回字段全部由它推出来 —— 见 `types.ts` 的注释，
 * 那里记着为什么不能直接 `Paths[P][M]`、以及 path 参数为什么要放宽成 string。
 *
 * ⚠️ **不要在外面再包一层函数去转发这五个方法** —— 包一层就把泛型擦成
 * `Promise<unknown>` 了，推断白做。要加行为（比如网络错误的文案）走
 * `ApiClientConfig` 上的注入点。
 */
export type ApiClient<Paths extends {}> = ApiMethods<Paths> & {
  /**
   * 非 JSON 传输：multipart 上传 / 原始字节下载。
   *
   * 走裸 `fetch` 而不是上面那五条，因为 openapi-fetch 会把 body 当 JSON
   * 序列化、把响应当 JSON 解析 —— 对 FormData 和 ArrayBuffer 都是错的。
   * 但 401 单飞刷新、`Accept-Language`、`Authorization` 必须共用，
   * 所以它在这里。**不要在业务层自己 new 一个 fetch。**
   *
   * 成功时返回原始 `Response`（body 还没被消费），由调用方决定怎么读。
   */
  sendRaw: (method: Method, path: string, body: BodyInit | undefined, accept: string) => Promise<Response>

  /** 会话失效回调可以在创建之后再注入（各端 auth 层的初始化顺序不同） */
  setSessionExpiredHandler: (fn: (() => void) | null) => void

  /**
   * 主动结束会话，走与 401 完全相同的收尾路径。
   *
   * 用于「我们**知道**服务端已经把 token 作废了」的场景，典型是改密码：
   * `user_service.update_password` 会 `delete_by_prefix` 掉该用户的
   * access / refresh / 用户缓存三组 key。不主动收场的话，用户会在下一个
   * 请求 401 时被莫名其妙弹回登录页 —— 看起来像 bug，其实是预期行为。
   */
  endSession: () => void
}

export function createApiClient<Paths extends {}>(config: ApiClientConfig): ApiClient<Paths> {
  let onSessionExpired: (() => void) | null = config.onSessionExpired ?? null

  /*
   * 🔴 **不要把 `getBaseUrl()` 的结果传进 `createClient({ baseUrl })`。**
   * openapi-fetch 在 `createClient` 里就把 `baseUrl` 解构出来固化了
   * （`let { baseUrl = '' } = { ...clientOptions }`，v0.15.2 src/index.js:26），
   * 传 getter 也只会被读一次。地址要跟着运行时变，必须走**每请求**的
   * `baseUrl` 覆盖（同文件 coreFetch 的 `localBaseUrl`）。
   * 写错的失败方式是静默的：移动端改完服务器地址，请求照旧发去旧地址。
   */
  const raw = createOpenApiClient({
    // web 需要它带上 httpOnly 的 refresh cookie；RN 忽略这个字段、自己有
    // cookie jar —— 两边都传是安全的
    credentials: 'include',
  })

  function authHeaders(): Record<string, string> {
    const token = config.getToken()
    return {
      'Accept-Language': config.getLanguage(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  // ─── 401 单飞刷新 ────────────────────────────────────────────────────────
  // 并发请求同时收到 401 时只允许一次 /auth/refresh 在途，其余排队等它的结果。
  // 没有这层，token 过期瞬间会打出 N 个 refresh，后端会话表和 Redis 都会被打乱。
  let refreshing: Promise<boolean> | null = null

  async function refreshToken(): Promise<boolean> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        // refresh token 在 httpOnly cookie 里 —— web 靠 `credentials: 'include'`，
        // RN 靠自带的 cookie jar。两边都**刻意不设 Authorization**。
        const res = await fetch(`${config.getBaseUrl()}/api/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Accept-Language': config.getLanguage() },
        })
        if (!res.ok) return false
        const body = (await res.json()) as { code?: number; data?: { access_token?: string } }
        const next = body?.data?.access_token
        if (!next) return false
        await config.setToken(next)
        return true
      } catch {
        return false
      } finally {
        // 交给微任务队列，确保同批次的等待者都拿到同一个结果后再复位
        queueMicrotask(() => {
          refreshing = null
        })
      }
    })()
    return refreshing
  }

  /** 网络层就没走通。把地址带上 —— RN 只给一句 `Network request failed` */
  function networkError(err: unknown, path: string): ApiError {
    const reason = err instanceof Error ? err.message : String(err)
    const base = new ApiError(NETWORK_STATUS, NETWORK_STATUS, reason, `${config.getBaseUrl()}${path}`)
    return config.onNetworkError ? config.onNetworkError(base) : base
  }

  async function expire(): Promise<void> {
    await config.clearToken()
    onSessionExpired?.()
  }

  /**
   * 发一个请求，并**拆掉 FBA 的 `{code,msg,data}` 包封**，
   * 让业务代码永远拿到裸 data。
   */
  async function send<T>(
    method: Method,
    path: string,
    init: Record<string, unknown> = {},
    retry = true,
  ): Promise<T> {
    const fn = (raw as unknown as Record<string, (p: string, i: unknown) => Promise<unknown>>)[method]
    const merged = {
      baseUrl: config.getBaseUrl(),
      ...init,
      headers: { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) },
    }

    let result: { data?: unknown; error?: unknown; response: Response }
    try {
      result = (await fn(path, merged)) as typeof result
    } catch (err) {
      // 网络层就没走通（连不上 / DNS / TLS）。RN 只给一句
      // `Network request failed`，不说是哪一种 —— 把地址带上，
      // 否则排查时完全没有线索。
      throw networkError(err, path)
    }

    /*
     * 🔴 成败判定走 `resolveEnvelope` —— **不要只看 `response.ok`**。
     * `response_base.fail()` 返回的是 HTTP 200 + `code: 400`，
     * 只看 HTTP 状态会把「写了 0 行」这类失败读成成功。详见 `envelope.ts`。
     */
    const outcome = resolveEnvelope<T>(result.response, result.error ?? result.data)

    if (!outcome.ok) {
      // 401 → 单飞刷新后重放一次；刷新失败则判定会话结束
      if (outcome.error.isUnauthorized && retry) {
        const ok = await refreshToken()
        if (ok) return send<T>(method, path, init, false)
        await expire()
      }
      throw outcome.error
    }

    return outcome.data
  }

  async function sendRaw(
    method: Method,
    path: string,
    body: BodyInit | undefined,
    accept: string,
    retry = true,
  ): Promise<Response> {
    // ⚠️ 绝对不要给 FormData 手写 Content-Type —— multipart 的 boundary 是运行时
    // 生成并塞进 header 的，手写一个不带 boundary 的 'multipart/form-data'
    // 会让后端解析不出任何字段（表现为「文件不能为空」）
    const headers = { ...authHeaders(), Accept: accept }

    let res: Response
    try {
      res = await fetch(`${config.getBaseUrl()}${path}`, { method, body, headers, credentials: 'include' })
    } catch (err) {
      throw networkError(err, path)
    }

    if (!res.ok) {
      if (res.status === 401 && retry) {
        const ok = await refreshToken()
        if (ok) return sendRaw(method, path, body, accept, false)
        await expire()
      }
      // 错误响应仍然是 FBA 的 JSON 包封，尽量把 msg 捞出来给用户看。
      // ⚠️ 只能在这个分支里 `res.json()` —— 成功路径的 body 是二进制/multipart，
      // 不能提前消费掉。
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch {
        // 不是 JSON（例如反代返回的 HTML 错误页）
      }
      const outcome = resolveEnvelope<never>(res, parsed)
      throw outcome.ok ? new ApiError(res.status, res.status, res.statusText) : outcome.error
    }
    return res
  }

  /*
   * ⚠️ 这里有一次**刻意的** `as`：`send()` 的运行时是按字符串路径转发的
   * （openapi-fetch 的实例也只能按方法名取），拿不到 `Paths` 的信息。
   * 类型面在 `types.ts` 里独立成立、并用探针核过（无参 / 雪花 ID 走 path 参数 /
   * 查询参数名 / 请求体 / 路径写错这 5 种），所以这一次转换是安全的边界。
   * **只有这一处**，不要在别处再 as。
   */
  return {
    GET: (path: string, init?: Record<string, unknown>) => send('GET', path, init),
    POST: (path: string, init?: Record<string, unknown>) => send('POST', path, init),
    PUT: (path: string, init?: Record<string, unknown>) => send('PUT', path, init),
    DELETE: (path: string, init?: Record<string, unknown>) => send('DELETE', path, init),
    PATCH: (path: string, init?: Record<string, unknown>) => send('PATCH', path, init),
    sendRaw: (method, path, body, accept) => sendRaw(method, path, body, accept),
    setSessionExpiredHandler: (fn) => {
      onSessionExpired = fn
    },
    endSession: () => {
      void config.clearToken()
      onSessionExpired?.()
    },
  } as ApiClient<Paths>
}
