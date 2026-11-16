#!/usr/bin/env node
/**
 * 移动端 E2E 的环境准备：关登录验证码、造测试数据，把流程要用的值打到 stdout。
 *
 *     node apps/mobile/e2e/setup.mjs >> "$GITHUB_ENV"      # CI
 *     export $(node apps/mobile/e2e/setup.mjs)             # 本地
 *
 * 输出是 `MAESTRO_XXX=值` 的行：Maestro 会把 `MAESTRO_` 开头的环境变量自动带进流程。
 * 进度和报错走 stderr，不混进那几行里。
 *
 * 零依赖（只用 Node 自带的 fetch），所以不用先装 workspace 依赖就能跑。
 *
 * 关验证码的写法照 `apps/web/e2e/global-setup.ts`：`/auth/login/swagger` 不校验验证码，
 * 用它拿 token；开关**无条件写一次再回读**，不先读再判断（参数配置有两级缓存，
 * 读到的可能是上一轮留下的值，理由见那个文件的头注释）。
 */
const API = process.env.E2E_API_BASE ?? 'http://127.0.0.1:8001'
/** 和 `src/lib/users.ts` 的 PAGE_SIZE 一致 —— 第二页第一条要按 App 自己的分页去问 */
const PAGE_SIZE = 20
const PASSWORD = 'E2eMobile@123456'

const log = (...a) => console.error('[mobile-e2e]', ...a)

function fail(msg) {
  console.error(`\n[mobile-e2e] ❌ ${msg}\n`)
  process.exit(1)
}

let token = ''

/** 后端的信封是 HTTP 200 + `code`，所以两层都要看 */
async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    fail(`${method} ${path} 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok || (typeof json.code === 'number' && json.code !== 200)) {
    fail(`${method} ${path} 失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
  return json
}

const login = await call('POST', '/api/v1/auth/login/swagger?username=admin&password=123456')
token = login.access_token
if (!token) fail('/auth/login/swagger 没给 access_token —— 后端连的是不是灌过种子的测试库？')

// ── 关验证码 ────────────────────────────────────────────────────────────
const configs = (await call('GET', '/api/v1/sys/configs/all?type=LOGIN')).data
const captcha = configs.find((c) => c.key === 'LOGIN_CAPTCHA_ENABLED')
if (!captcha) fail('sys_config 里找不到 LOGIN_CAPTCHA_ENABLED —— 种子数据的键名是不是改了？')
await call('PUT', `/api/v1/sys/configs/${captcha.id}`, {
  name: captcha.name,
  type: captcha.type,
  key: captcha.key,
  value: 'false',
  is_frontend: captcha.is_frontend,
  remark: captcha.remark,
})
const now = (await call('GET', '/api/v1/sys/configs/all?type=LOGIN')).data.find(
  (c) => c.key === 'LOGIN_CAPTCHA_ENABLED',
)?.value
if (now !== 'false') fail(`验证码开关写完回读还是 ${now}`)
log('验证码已关')

// ── 测试数据 ────────────────────────────────────────────────────────────
const depts = (await call('GET', '/api/v1/sys/depts')).data
if (!depts?.length) fail('一个部门都没有，建不了用户')
const deptId = depts[0].id

// 用户名带一段时间戳：同一个库上重跑不会撞唯一约束
const stamp = Date.now().toString(36)

async function createUser(username, nickname) {
  await call('POST', '/api/v1/sys/users', {
    username,
    password: PASSWORD,
    nickname,
    dept_id: deptId,
    // 一个角色都不给 —— 「权限门控」那条流程要的就是一个什么都看不到的账号
    roles: [],
  })
}

async function findUser(username) {
  const page = (await call('GET', `/api/v1/sys/users?page=1&size=${PAGE_SIZE}&username=${username}`)).data
  const hit = page.items.find((u) => u.username === username)
  if (!hit) fail(`刚建的用户 ${username} 在列表里搜不到`)
  return hit
}

// 凑够两页：种子里的用户不到一页，翻页那一步要有第二页可翻
const before = (await call('GET', `/api/v1/sys/users?page=1&size=${PAGE_SIZE}`)).data.total
const fillers = Math.max(0, PAGE_SIZE + 5 - before)
for (let i = 0; i < fillers; i++) {
  await createUser(`e2e_fill_${stamp}_${i}`, `Filler ${i}`)
}
log(`原有 ${before} 个用户，补了 ${fillers} 个`)

const delName = `e2e_del_${stamp}`
await createUser(delName, 'E2E Delete Me')
const delUser = await findUser(delName)

const limitedName = `e2e_limited_${stamp}`
await createUser(limitedName, 'E2E Limited')

// 第二页第一条：只有翻过页它才会出现在屏上。用 App 自己的分页参数去问，顺序才对得上
const page2 = (await call('GET', `/api/v1/sys/users?page=2&size=${PAGE_SIZE}`)).data
if (!page2.items.length) fail(`用户总数 ${page2.total}，凑不出第二页`)
log(`共 ${page2.total} 个用户，第二页第一条是 ${page2.items[0].username}`)

// 🔴 ID 是雪花 ID，全程当字符串用（根 CLAUDE.md 硬纪律 6）
const out = {
  MAESTRO_PAGE2_ROW: `user-row-${page2.items[0].id}`,
  MAESTRO_DEL_USERNAME: delName,
  MAESTRO_DEL_ROW: `user-row-${delUser.id}`,
  MAESTRO_LIMITED_USERNAME: limitedName,
  MAESTRO_E2E_PASSWORD: PASSWORD,
}
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`)
