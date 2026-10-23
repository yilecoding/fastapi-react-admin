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
import { ApiError, UploadAbortedError } from './errors'
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

  /**
   * 刷新也救不回来时的收尾（清状态 + 跳登录页）。由各端 auth 层注入。
   * 带上会话结束的原因（被踢 / 空闲 / 到期 …），登录页据此告诉用户为什么要重新登录（#138）
   */
  onSessionExpired?: (end: SessionEnd) => void

  /**
   * 换一枚新的 access token。**不传就走默认的 cookie 刷新**（web 靠 `credentials: 'include'`、
   * RN 靠自带的 cookie jar）。桌面端传自己的：渲染层跑在 `app://local` 下，对后端是跨站，
   * 浏览器压根不带 refresh cookie —— 只能交给主进程去刷（`apps/desktop/src/main/auth.ts`）
   */
  refresh?: () => Promise<RefreshOutcome>

  /**
   * 用户多少秒没碰键盘 / 鼠标 / 触屏了，发成 `X-Client-Idle`（#138）。
   *
   * 服务端的空闲超时按**人有没有在操作**算：后台轮询（在线用户页 10 秒一次、监控页…）
   * 带着很大的空闲秒数，就不会把一个人已经走开的会话续上。不传 = 不带这个头，
   * 服务端按「刚操作过」算（移动端就是这样）
   */
  getClientIdle?: () => number | null

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

/** 会话为什么结束。`reason` 是后端的原因码，说不出原因时是 null（见 `ApiError.sessionEndReason`） */
export type SessionEnd = { reason: string | null; message: string | null }

/**
 * 一次刷新的结果，**分三种，不是成败两种**（#138）：
 *
 * - `ok`：拿到新 token
 * - `ended`：会话真的结束了（401 / 403）—— 清登录态、回登录页
 * - `transient`：5xx / 429 / 网络不通 / 超时 —— **不清登录态**，只把错误抛给这次请求。
 *   以前任何失败都走「清登录态」，于是后端重启 / 发版的那几秒里 token 恰好到期的人全被踢回登录页
 */
export type RefreshOutcome =
  | { kind: 'ok'; token: string }
  | { kind: 'ended'; end: SessionEnd }
  | { kind: 'transient'; error: ApiError }

/**
 * 刷新请求的超时。🔴 必须短于后端的宽限期（`SESSION_REFRESH_GRACE_SECONDS`，默认 30 秒）：
 * 响应丢了之后拿旧 refresh token 重试，超过宽限期就会被判成盗用、整个会话撤销
 */
export const REFRESH_TIMEOUT_MS = 10_000

const REFRESH_PATH = '/api/v1/auth/refresh'

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

  /**
   * multipart 上传，**带上传进度、可取消**，返回拆过包封的裸 data。
   *
   * 走 `XMLHttpRequest` 而不是 fetch —— 后者拿不到上传进度事件（浏览器和 RN 都是）。
   * 鉴权头 / `Accept-Language` / 401 单飞刷新 + 重放一次 / 信封判定，和 `send()` 一致。
   */
  sendUpload: <T>(path: string, body: FormData | Blob, options?: UploadOptions) => Promise<T>

  /** 会话失效回调可以在创建之后再注入（各端 auth 层的初始化顺序不同） */
  setSessionExpiredHandler: (fn: ((end: SessionEnd) => void) | null) => void

  /**
   * 主动结束会话，走与 401 完全相同的收尾路径。
   *
   * 用于「我们**知道**服务端已经把会话作废了」的场景：改密码（服务端撤销该用户的全部会话）、
   * socket 推来的 `session:ended`。不主动收场的话，用户会在下一个请求 401 时被莫名其妙
   * 弹回登录页 —— 看起来像 bug，其实是预期行为。
   */
  endSession: (end?: SessionEnd) => void

  /**
   * 用 refresh 凭据换一枚 access token（和 401 走的是**同一个单飞**）。
   *
   * access token 只放内存之后（#138），页面加载 / 新开标签页时手里没有 token，
   * 路由守卫先调它静默恢复，失败再去登录页。成功时已经 `setToken` 过了
   */
  restoreSession: () => Promise<RefreshOutcome>
}

/** `sendUpload` 的可选项：进度回调 + 取消信号 */
export interface UploadOptions {
  /** 默认 POST；分片上传是 PUT */
  method?: 'POST' | 'PUT'
  /** 已发送 / 总字节数（来自 XHR 的 `upload.onprogress`，`lengthComputable` 时才调） */
  onProgress?: (loaded: number, total: number) => void
  /** 触发后 XHR 立即 abort，Promise 以 `UploadAbortedError`（`name === 'AbortError'`）拒绝 */
  signal?: AbortSignal
}

export function createApiClient<Paths extends {}>(config: ApiClientConfig): ApiClient<Paths> {
  let onSessionExpired: ((end: SessionEnd) => void) | null = config.onSessionExpired ?? null

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
    const idle = config.getClientIdle?.()
    return {
      'Accept-Language': config.getLanguage(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idle != null && idle >= 0 ? { 'X-Client-Idle': String(Math.floor(idle)) } : {}),
    }
  }

  /** 默认的刷新：refresh token 在 httpOnly cookie 里，web 靠 `credentials: 'include'`、RN 靠 cookie jar */
  async function cookieRefresh(): Promise<RefreshOutcome> {
    // 手写超时而不是 `AbortSignal.timeout()`：RN（Hermes）上没有那个静态方法
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    let res: Response
    let body: unknown = null
    try {
      res = await fetch(`${config.getBaseUrl()}${REFRESH_PATH}`, {
        method: 'POST',
        credentials: 'include',
        // 刻意不设 Authorization：身份只认 refresh cookie
        headers: { 'Accept-Language': config.getLanguage() },
        signal: controller.signal,
      })
      try {
        body = await res.json()
      } catch {
        // 不是 JSON（反代的 HTML 错误页之类）
      }
    } catch (err) {
      return { kind: 'transient', error: networkError(err, REFRESH_PATH) }
    } finally {
      clearTimeout(timer)
    }
    const outcome = resolveEnvelope<{ access_token?: string }>(res, body)
    if (outcome.ok) {
      const token = outcome.data?.access_token
      return token
        ? { kind: 'ok', token }
        : { kind: 'transient', error: new ApiError(res.status, res.status, 'refresh 响应里没有 access_token') }
    }
    // 401 / 403 才是「会话真的结束了」；5xx / 429 / 其它都只是这一次没刷成
    if (outcome.error.httpStatus === 401 || outcome.error.httpStatus === 403) {
      return { kind: 'ended', end: { reason: outcome.error.sessionEndReason, message: outcome.error.message || null } }
    }
    return { kind: 'transient', error: outcome.error }
  }

  // ─── 401 单飞刷新 ────────────────────────────────────────────────────────
  // 并发请求同时收到 401 时只允许一次 /auth/refresh 在途，其余排队等它的结果。
  // 没有这层，token 过期瞬间会打出 N 个 refresh —— 后端的宽限期回放兜得住（#138），
  // 但没必要让它兜
  let refreshing: Promise<RefreshOutcome> | null = null

  async function refreshToken(): Promise<RefreshOutcome> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const outcome = await (config.refresh ?? cookieRefresh)()
        if (outcome.kind === 'ok') await config.setToken(outcome.token)
        return outcome
      } catch (err) {
        // 注入的 refresh 自己炸了（桌面端 IPC 断了之类）：当成这一次没刷成，不清登录态
        return { kind: 'transient', error: networkError(err, REFRESH_PATH) } as RefreshOutcome
      } finally {
        // 交给微任务队列，确保同批次的等待者都拿到同一个结果后再复位
        queueMicrotask(() => {
          refreshing = null
        })
      }
    })()
    return refreshing
  }

  /**
   * 401 之后：刷新成功 → 重放；会话结束 → 收尾；暂时失败 → 不清登录态，把那个错误抛给调用方。
   * 返回 true 表示可以重放；否则抛出该抛的错误
   *
   * @param sentWithToken 这次请求发出去时带没带 token。🔴 **没带的 401 不刷新、不收尾**：
   *   token 为空说明会话已经在本地结束了（页面加载时的恢复由守卫做，不走这里）。不拦的话：
   *   收尾里 `queryClient.clear()` 一清缓存，还没卸载的组件立刻重新取数，这批不带 token 的请求
   *   全部 401 → 又去刷新（cookie 已经删了）→ 拿到一个**不带原因**的 401 → 再收尾一次，
   *   把「因为什么被登出」的那次跳转覆盖掉。实测：另一个标签页登出后，这个标签页先跳到
   *   `/sign-in?reason=logout`、紧接着又被覆盖成 `/sign-in`，提示条没了
   */
  async function recover(original: ApiError, sentWithToken: boolean): Promise<true> {
    if (!sentWithToken) throw original
    const outcome = await refreshToken()
    if (outcome.kind === 'ok') return true
    if (outcome.kind === 'ended') {
      await expire(outcome.end)
      throw original
    }
    throw outcome.error
  }

  /** 网络层就没走通。把地址带上 —— RN 只给一句 `Network request failed` */
  function networkError(err: unknown, path: string): ApiError {
    const reason = err instanceof Error ? err.message : String(err)
    const base = new ApiError(NETWORK_STATUS, NETWORK_STATUS, reason, `${config.getBaseUrl()}${path}`)
    return config.onNetworkError ? config.onNetworkError(base) : base
  }

  async function expire(end: SessionEnd): Promise<void> {
    await config.clearToken()
    onSessionExpired?.(end)
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
    const sentWithToken = config.getToken() !== null
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
      // 401 → 单飞刷新后重放一次；会话结束才收尾，暂时失败只把错误抛出去
      if (outcome.error.isUnauthorized && retry) {
        await recover(outcome.error, sentWithToken)
        return send<T>(method, path, init, false)
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
    const sentWithToken = config.getToken() !== null
    const headers = { ...authHeaders(), Accept: accept }

    let res: Response
    try {
      res = await fetch(`${config.getBaseUrl()}${path}`, { method, body, headers, credentials: 'include' })
    } catch (err) {
      throw networkError(err, path)
    }

    if (!res.ok) {
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
      const error = outcome.ok ? new ApiError(res.status, res.status, res.statusText) : outcome.error
      if (res.status === 401 && retry) {
        await recover(error, sentWithToken)
        return sendRaw(method, path, body, accept, false)
      }
      throw error
    }
    return res
  }

  function sendUpload<T>(path: string, body: FormData | Blob, options: UploadOptions = {}, retry = true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new UploadAbortedError())
        return
      }
      const xhr = new XMLHttpRequest()
      const sentWithToken = config.getToken() !== null
      xhr.open(options.method ?? 'POST', `${config.getBaseUrl()}${path}`)
      // 同 sendRaw：带上 httpOnly 的 refresh cookie（RN 忽略）
      xhr.withCredentials = true
      // ⚠️ 同样不要手写 multipart 的 Content-Type，boundary 由 XHR 自己生成
      for (const [k, v] of Object.entries({ ...authHeaders(), Accept: 'application/json' })) {
        xhr.setRequestHeader(k, v)
      }
      // 裸字节（分片）：显式声明成二进制 —— 后端操作日志据此不去读、不去记它
      if (!(body instanceof FormData)) xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      const onAbort = () => xhr.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) options.onProgress?.(e.loaded, e.total)
      }
      xhr.onerror = () => {
        cleanup()
        reject(networkError(new Error('upload failed'), path))
      }
      xhr.onabort = () => {
        cleanup()
        reject(new UploadAbortedError())
      }
      xhr.onload = () => {
        cleanup()
        let parsed: unknown = null
        try {
          parsed = JSON.parse(xhr.responseText)
        } catch {
          // 不是 JSON（反代的 HTML 错误页之类）
        }
        const status = xhr.status
        const outcome = resolveEnvelope<T>({ ok: status >= 200 && status < 300, status, statusText: xhr.statusText }, parsed)
        if (outcome.ok) {
          resolve(outcome.data)
          return
        }
        if (outcome.error.isUnauthorized && retry) {
          // 刷新成功就整个重放一次（FormData 可以重复发送）；失败走和 send() 相同的收尾
          recover(outcome.error, sentWithToken).then(
            () => sendUpload<T>(path, body, options, false).then(resolve, reject),
            reject,
          )
          return
        }
        reject(outcome.error)
      }
      xhr.send(body)
    })
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
    sendUpload: (path, body, options) => sendUpload(path, body, options),
    setSessionExpiredHandler: (fn) => {
      onSessionExpired = fn
    },
    endSession: (end = { reason: null, message: null }) => {
      void config.clearToken()
      onSessionExpired?.(end)
    },
    restoreSession: () => refreshToken(),
  } as ApiClient<Paths>
}
