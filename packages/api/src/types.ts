import type { FetchResponse, MaybeOptionalInit } from 'openapi-fetch'
import type { HttpMethod, PathsWithMethod, RequiredKeysOf } from 'openapi-typescript-helpers'

/**
 * 从生成的 `schema.d.ts` 推出**每个路径各自的**入参和返回类型。
 *
 * 🔴 **这一层是这个包存在的第二个理由。** 在它之前，`api.GET<T>()` 的 `T`
 * 是**手写**的：123 个调用点里 71 个自己声明了一遍返回结构，和 `schema.d.ts`
 * **从来没有对过账**。写错一个字段名不会有任何信号 —— 界面上就空一格。
 * 移动端更彻底，整份 DTO 是手抄的（`src/lib/contract.ts`，已删）。
 *
 * 现在路径、查询参数名、请求体、返回字段全部从 schema 推出来，写错就是编译错误。
 */

type Json = `${string}/json`

/**
 * 拆掉 FBA 信封。
 *
 * `schema.d.ts` 里 200 响应的形状就是 `{code,msg,data}`
 * （`ResponseSchemaModel_X_`），而业务代码要的一直是里面那个 `data` ——
 * 客户端运行时已经拆了（见 `envelope.ts`），类型这边也要跟着拆，
 * 否则每个调用点都得写 `.data`。
 */
export type Payload<T> = T extends { data?: infer D } ? D : T

/**
 * 🔴 **不能直接写 `Paths[P][M]`。**
 *
 * `paths` 是**接口**、没有索引签名，TS 无法为泛型 `Paths` 证明
 * `M extends keyof Paths[P]`。openapi-fetch 自己的 `ClientMethod` 把 Paths
 * 约束成 `Record<string, Record<HttpMethod, {}>>` —— **`paths` 不满足那个约束**
 * （`Index signature for type 'string' is missing`），它们的 `.d.ts` 只是被
 * `skipLibCheck: true` 盖住了，而我们自己的代码是要真检查的。
 * 所以这里用条件类型把双重索引拆开。
 */
type Op<Paths, P extends keyof Paths, M extends HttpMethod> = M extends keyof Paths[P] ? Paths[P][M] : never
type InitOf<Paths, P extends keyof Paths, M extends HttpMethod> = M extends keyof Paths[P]
  ? MaybeOptionalInit<Paths[P], M>
  : never

/**
 * 🔴 **path 参数要放宽成 `string | number`（根 CLAUDE.md 硬纪律 6）。**
 *
 * 后端的 Python 类型标注是 `int`，所以 OpenAPI 把 **44 个** path 参数声明成
 * `number`。但雪花 ID 约 2^61、超出 `Number.MAX_SAFE_INTEGER`，本项目里
 * **所有 ID 都是 string**（后端 `stringify_unsafe_ints` 统一转的）。
 *
 * 不放宽的话只有两条路，两条都是错的：调用点传 string 编译不过，
 * 或者 `Number(id)` 一下 —— 后者会让 `2049629108245233664` 变成
 * `2049629108245233700`，连续 6 个菜单 ID 塌成同一个值，更新/删除命中错记录。
 */
type LoosePath<P> = { [K in keyof P]: number extends P[K] ? P[K] | string : P[K] }
type LooseInit<I> = I extends { params: { path: infer PP } }
  ? Omit<I, 'params'> & { params: Omit<I['params'], 'path'> & { path: LoosePath<PP> } }
  : I

/** 没有必填项时第二个参数可省（照 openapi-fetch 内部的 `InitParam` 写法） */
type InitArg<I> = RequiredKeysOf<LooseInit<I>> extends never
  ? [(LooseInit<I> & Record<string, unknown>)?]
  : [LooseInit<I> & Record<string, unknown>]

export type ApiMethod<Paths extends {}, M extends HttpMethod> = <P extends PathsWithMethod<Paths, M>>(
  path: P,
  ...init: InitArg<InitOf<Paths, P, M>>
) => Promise<
  Payload<NonNullable<FetchResponse<Op<Paths, P, M> & Record<string | number, unknown>, object, Json>['data']>>
>

/** 五个方法的类型面。`ApiClient` 在它之上再加 `sendRaw` 那几样 */
export type ApiMethods<Paths extends {}> = {
  GET: ApiMethod<Paths, 'get'>
  POST: ApiMethod<Paths, 'post'>
  PUT: ApiMethod<Paths, 'put'>
  DELETE: ApiMethod<Paths, 'delete'>
  PATCH: ApiMethod<Paths, 'patch'>
}
