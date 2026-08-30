import { request } from "@playwright/test"

const API_BASE = process.env.E2E_API_BASE ?? "http://127.0.0.1:8001"

/**
 * 跑一次的环境准备：把 fba_test 里的登录验证码关掉。
 *
 * `.env.e2e` 里已经写了 `LOGIN_CAPTCHA_ENABLED=false`，但这个开关会被 sys_config
 * 表里的种子值（'true'）在**运行时**覆盖回去（CLAUDE.md「参数配置」那节：
 * `load_user_security_config` 会在登录/验证码路径上把 sys_config 的值 setattr 到
 * settings 上，覆盖 .env）。所以只改 .env.e2e 不够，还要把 fba_test 这一条种子数据
 * 也改掉。
 *
 * `/auth/login/swagger` 不校验验证码（给 API 测试用的便捷接口，不是真实登录表单
 * 走的 `/auth/login`），用它登录、改这一条配置，剩下所有测试——包括驱动真实登录
 * 表单的 login.spec.ts——就都能看到验证码是关的。
 *
 * 🔴 **无条件写一次，不要先读再判断「已经是 false 就跳过」。**
 * `config_service.get_all()` 挂着 `@cached`（Redis + 本地两级，TTL 2 小时，
 * e2e 用 Redis db 2）。而 `pnpm --filter api test:db` 重建的是 **SQL 库**，
 * 不碰 Redis —— 于是种子把 `LOGIN_CAPTCHA_ENABLED` 打回 `'true'`，缓存里却还留着
 * 上一轮 e2e 写下的 `'false'`。读到的是缓存那份，条件判断得出「已经关了」，
 * 这一步就跳过了，**库里那条从头到尾没被改过**。
 * 后果是延迟且随机的：缓存没过期时登录照常，缓存一过期（或换个进程）真值 `'true'`
 * 生效，此后**每一条走真实登录表单的用例**（login / session-tabs）当场红，
 * 报的是「停在 /sign-in」，跟验证码八竿子打不着。实测踩过一次，两条红。
 * 写入接口带 `@cache_invalidate`，所以无条件 PUT 一次能同时把库和缓存都摆正。
 */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: API_BASE })

  const loginRes = await ctx.post("/api/v1/auth/login/swagger", {
    params: { username: "admin", password: "123456" },
  })
  if (!loginRes.ok()) {
    throw new Error(
      `E2E 环境准备失败：/auth/login/swagger 登录拿 token 失败（HTTP ${loginRes.status()}）。` +
        "先确认 api:e2e 实例连的是 fba_test，且 fba_test 已经建好种子（pnpm --filter api test:db）。"
    )
  }
  const { access_token } = (await loginRes.json()) as { access_token: string }
  const headers = { Authorization: `Bearer ${access_token}` }

  const configsRes = await ctx.get("/api/v1/sys/configs/all?type=LOGIN", { headers })
  const configsBody = (await configsRes.json()) as {
    data: Array<{
      id: string
      name: string
      type: string | null
      key: string
      value: string
      is_frontend: boolean
      remark: string | null
    }>
  }
  const captchaConfig = configsBody.data.find((c) => c.key === "LOGIN_CAPTCHA_ENABLED")
  if (!captchaConfig) {
    throw new Error(
      "E2E 环境准备失败：sys_config 里找不到 LOGIN_CAPTCHA_ENABLED —— 种子数据的键名是不是改了？" +
        "login.spec.ts 依赖这个开关能被关掉。"
    )
  }

  const putRes = await ctx.put(`/api/v1/sys/configs/${captchaConfig.id}`, {
    headers,
    data: {
      name: captchaConfig.name,
      type: captchaConfig.type,
      key: captchaConfig.key,
      value: "false",
      is_frontend: captchaConfig.is_frontend,
      remark: captchaConfig.remark,
    },
  })
  if (!putRes.ok()) {
    throw new Error(`E2E 环境准备失败：关闭验证码没成功（HTTP ${putRes.status()}）。`)
  }

  // 回读一次确认真的写进去了。写入接口带 `@cache_invalidate`，所以这次读的是库里的
  // 新值 —— 这条断言就是上面那个「缓存骗了你」的坑的守卫：以后再出现「写了但没生效」，
  // 会在环境准备这一步当场炸，而不是攒到某条登录用例上变成一个看不懂的失败。
  const verifyRes = await ctx.get("/api/v1/sys/configs/all?type=LOGIN", { headers })
  const verifyBody = (await verifyRes.json()) as { data: Array<{ key: string; value: string }> }
  const captchaNow = verifyBody.data.find((c) => c.key === "LOGIN_CAPTCHA_ENABLED")?.value
  if (captchaNow !== "false") {
    throw new Error(
      `E2E 环境准备失败：验证码开关写完回读还是 ${captchaNow}。` +
        "多半是参数配置的缓存没被写入接口失效掉（fba:cache:config，e2e 用 Redis db 2）。"
    )
  }

  await ctx.dispose()
}
