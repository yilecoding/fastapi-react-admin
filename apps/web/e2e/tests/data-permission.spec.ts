import { expect, test, createApiClient, loginPageAs, type ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

import type { Page } from "@playwright/test"

/**
 * 数据权限 —— **多账号**端到端。
 *
 * 后端已经有一份同名矩阵（`apps/api/backend/app/admin/tests/api_v1/test_data_permission.py`），
 * 这份不是它的复制品，两边看的是不同的东西：
 *
 * | | pytest 那份 | 这一份 |
 * |---|---|---|
 * | 断言对象 | `GET /sys/depts` 返回的**编码集合** | 部门页**真正渲染出来的行** |
 * | 能看见 | WHERE 条件对不对 | 树被过滤后**塌成什么形状**（父级被滤掉，子节点提到顶层）、空态是「没有匹配」还是错误、界面上那三条语义告警在不在 |
 * | 覆盖 | 后端一个接口 | 路由守卫 → 权限码 → 列表 → 主从页配置链路 |
 *
 * 一句话：**规则算得对不对是后端的事，配的人看不看得懂是前端的事。**
 * 数据权限最容易出的问题恰恰是后者 —— 「本部门数据权限」实际放行全部、
 * 一条 OR 规则抬掉所有 AND，这两条后端只能返回一个「结果集」，
 * 是不是符合预期得有人看；界面上那两条告警（`rule-mixed-warn` / `scope-inert`）
 * 就是替人看的那一层，所以它们必须有测试。
 *
 * 🔴 **前置数据整批建在 `beforeAll` 里**（19 个账号 + 19 个角色 + 18 个范围 + 16 条规则
 * + 6 个部门）。每条测试重建一遍要 20 秒以上，跑完一轮矩阵就没法看了。
 * 代价是这个 describe 必须 `mode: 'serial'` —— 并行 worker 各跑一次 `beforeAll`
 * 会撞唯一约束（编码/角色名/用户名都是唯一的）。
 */

test.describe.configure({ mode: "serial", timeout: 90_000 })

const PASSWORD = "Dp!123456"
/** 部门页那个 tab 的容器。按 routeId 锁，不按 `data-visible` —— 见根 CLAUDE.md 硬纪律 5 */
const DEPT_PANE = '[data-tab="/_auth/system/dept"]'

// 🔴 短前缀是**硬约束**，不是风格：`sys_role.name` 只有 `UniversalStr(32)`，
// 拼出 33 个字符时 SQL Server 报的是 `String or binary data would be truncated`
// —— 一句看不出是哪张表哪一列的 500。实测踩过（`E2E角色-DPE_XXXXXXXXXXXX-UNFILTERED` = 34）
const SFX = uniqueCode("D")

/** 表达式枚举，和后端 `RoleDataRuleExpressionType` 一一对应 */
const EQ = 0
const NE = 1
const LT = 4
const IN = 6
const NOT_IN = 7
/** 连接方式：`RoleDataRuleOperatorType` */
const AND = 0
const OR = 1

type DeptKey = "RA" | "A1" | "A2" | "RB" | "B1" | "OUT"
const DEPT_KEYS: DeptKey[] = ["RA", "A1", "A2", "RB", "B1", "OUT"]

/** 部门树：RA→(A1,A2) · RB→(B1) · OUT（谁的规则都不匹配它，用来证明"没过滤"） */
const DEPT_TREE: Array<{ key: DeptKey; parent?: DeptKey }> = [
  { key: "RA" },
  { key: "A1", parent: "RA" },
  { key: "A2", parent: "RA" },
  { key: "RB" },
  { key: "B1", parent: "RB" },
  { key: "OUT" },
]

const deptCode = (k: DeptKey) => `${SFX}${k}`
const deptName = (k: DeptKey) => `E2E部门${k}${SFX}`

type RuleSpec = {
  model: string
  column: string
  operator?: 0 | 1
  expression?: number
  value: string
}

type Scenario = {
  key: string
  /** 出现在测试名里的中文说明 */
  desc: string
  rules: RuleSpec[]
  /** 数据范围状态，默认启用 */
  scopeStatus?: 0 | 1
  /** 角色的「启用数据权限过滤」，默认开 */
  isFilter?: boolean
  /** 这个角色本身停用（再配一个启用的兜底角色，否则登录直接被拒） */
  roleDisabled?: boolean
  /** 额外再挂一个「不过滤」的角色 */
  plusUnfilteredRole?: boolean
  /** 兜底角色的规则（只有 roleDisabled 用得上） */
  fallbackRules?: RuleSpec[]
  /** 用户所在部门，`null` = 没有部门 */
  dept?: DeptKey | null
  /** 期望在部门页上看到的部门（本次创建的这 6 个之内） */
  visible: DeptKey[] | "all" | "none"
  /** 这条场景由专门的用例驱动，不进矩阵循环 */
  manual?: boolean
}

const SCENARIOS: Scenario[] = [
  // ---- 不过滤 -----------------------------------------------------------
  {
    key: "nofilter",
    desc: "角色关掉「启用数据权限过滤」→ 看见全部",
    rules: [],
    isFilter: false,
    visible: "all",
  },
  {
    key: "mixed",
    desc: "🔴 一严一松两个角色 → 松的赢，严的那份限制一条都不看",
    rules: [{ model: "Dept", column: "code", value: deptCode("A1") }],
    plusUnfilteredRole: true,
    visible: "all",
  },

  // ---- 看不见 -----------------------------------------------------------
  {
    key: "noscope",
    desc: "开了过滤却没绑任何数据范围 → 一个部门都看不到（不是「看全部」）",
    rules: [],
    visible: "none",
  },
  {
    key: "scopeoff",
    desc: "数据范围停用 → 规则不参与，退化成「没有范围」",
    rules: [{ model: "Dept", column: "code", value: deptCode("A1") }],
    scopeStatus: 0,
    visible: "none",
  },
  {
    key: "roleoff",
    desc: "停用角色带的范围不算数，只有启用角色的限制生效",
    rules: [{ model: "Dept", column: "code", value: deptCode("A1") }],
    roleDisabled: true,
    fallbackRules: [{ model: "Dept", column: "parent_id", value: "@RA" }],
    visible: ["A1", "A2"],
  },

  // ---- 表达式矩阵 -------------------------------------------------------
  {
    key: "eq",
    desc: "== 编码",
    rules: [{ model: "Dept", column: "code", value: deptCode("A1") }],
    visible: ["A1"],
  },
  {
    key: "parent",
    desc: "== 上级部门 ID",
    rules: [{ model: "Dept", column: "parent_id", value: "@RA" }],
    visible: ["A1", "A2"],
  },
  {
    key: "inlist",
    desc: "in（逗号分隔）",
    rules: [
      { model: "Dept", column: "code", expression: IN, value: `${deptCode("A1")},${deptCode("B1")}` },
    ],
    visible: ["A1", "B1"],
  },
  {
    key: "notin",
    desc: "not_in（值里带空格也要被 strip 掉）",
    rules: [
      { model: "Dept", column: "code", expression: NOT_IN, value: `${deptCode("A1")}, ${deptCode("B1")}` },
    ],
    visible: ["RA", "A2", "RB", "OUT"],
  },
  {
    key: "and2",
    desc: "两条 AND 规则求交",
    rules: [
      { model: "Dept", column: "parent_id", value: "@RA" },
      { model: "Dept", column: "code", expression: NE, value: deptCode("A2") },
    ],
    visible: ["A1"],
  },
  {
    key: "or2",
    desc: "两条 OR 规则求并",
    rules: [
      { model: "Dept", column: "code", operator: OR, value: deptCode("A1") },
      { model: "Dept", column: "code", operator: OR, value: deptCode("B1") },
    ],
    visible: ["A1", "B1"],
  },
  {
    key: "andor",
    desc: "🔴 AND 组和 OR 组在顶层是 OR —— 一条 OR 规则把所有 AND 限制抬掉",
    rules: [
      { model: "Dept", column: "parent_id", value: "@RA" },
      { model: "Dept", column: "status", operator: OR, value: "1" },
    ],
    visible: "all",
  },

  // ---- 🔴 fail-open：规则落不到列上 = 完全不过滤 --------------------------
  {
    key: "ghostcol",
    desc: "🔴 字段名不存在（后端建规则时不校验）→ 放行全部",
    rules: [{ model: "Dept", column: "no_such_column", value: "x" }],
    visible: "all",
  },
  {
    key: "deptidtpl",
    desc: "🔴 种子里的「本部门数据权限」（Dept.__dept_id__）—— sys_dept 没这一列，实际放行全部",
    rules: [{ model: "Dept", column: "__dept_id__", value: "${dept_id}" }],
    visible: "all",
  },
  {
    key: "othermodel",
    desc: "🔴 规则只打在 User 上 → 部门接口拿不到匹配模型 → 放行全部",
    rules: [{ model: "User", column: "is_superuser", expression: NE, value: "1" }],
    visible: "all",
  },

  // ---- 值模板变量 -------------------------------------------------------
  {
    key: "depttpl",
    desc: "${dept_id} 取当前用户部门（用户在 RA，规则 parent_id == ${dept_id}）",
    rules: [{ model: "Dept", column: "parent_id", value: "${dept_id}" }],
    dept: "RA",
    visible: ["A1", "A2"],
  },
  {
    key: "nulldept",
    desc: "用户没有部门 → ${dept_id} 解析不出值 → fail-closed（不是 500、也不是放行）",
    rules: [{ model: "Dept", column: "parent_id", value: "${dept_id}" }],
    dept: null,
    visible: "none",
  },
  {
    key: "nowtpl",
    desc: "${now} 要是调用结果（created_time < ${now}，全部都是过去建的）",
    rules: [{ model: "Dept", column: "created_time", expression: LT, value: "${now}" }],
    visible: "all",
  },

  // ---- 由专门的用例驱动，不进矩阵循环 ------------------------------------
  {
    key: "cachebust",
    desc: "改绑定后不重登就生效",
    rules: [{ model: "Dept", column: "code", value: deptCode("A1") }],
    visible: ["A1"],
    manual: true,
  },
  {
    key: "uiflow",
    desc: "整条链路都在界面上走一遍",
    rules: [],
    visible: "none",
    manual: true,
  },
]

// --------------------------------------------------------------------------
// 建图 / 拆图
// --------------------------------------------------------------------------

type Built = {
  deptId: Record<DeptKey, string>
  scopeId: Record<string, string>
  roleId: Record<string, string>
  ruleIds: string[]
  userId: Record<string, string>
  username: Record<string, string>
}

let api: ApiClient
let disposeApi: () => Promise<void>
let g: Built

const username = (key: string) => `dp_${SFX}_${key}`.toLowerCase()

/** 规则里写 `@RA` 表示「RA 部门的雪花 ID」—— 建图时才知道，所以延后到这里替换 */
function resolveValue(v: string): string {
  const m = /^@(\w+)$/.exec(v)
  return m ? g.deptId[m[1] as DeptKey] : v
}

async function createRule(scenarioKey: string, i: number, spec: RuleSpec): Promise<string> {
  const rule = (await api.post("/api/v1/sys/data-rules", {
    name: `E2E规则-${SFX}-${scenarioKey}-${i}`,
    model: spec.model,
    column: spec.column,
    operator: spec.operator ?? AND,
    expression: spec.expression ?? EQ,
    value: resolveValue(spec.value),
  })) as { id: string }
  g.ruleIds.push(rule.id)
  return rule.id
}

/** 建一个数据范围并把规则挂上，返回范围 id */
async function createScope(name: string, ruleIds: string[], status: 0 | 1 = 1): Promise<string> {
  await api.post("/api/v1/sys/data-scopes", { name, status })
  const all = (await api.get("/api/v1/sys/data-scopes/all")) as Array<{ id: string; name: string }>
  const scope = all.find((s) => s.name === name)
  if (!scope) throw new Error(`数据范围建完却找不到：${name}`)
  // 空数组也要 PUT 一次？不需要 —— 新建的范围本来就没有规则
  if (ruleIds.length > 0) {
    await api.put(`/api/v1/sys/data-scopes/${scope.id}/rules`, { rules: ruleIds })
  }
  return scope.id
}

/** 建一个角色，绑范围 + 绑「部门管理」那几个菜单（否则路由守卫会把人踢去 /403） */
async function createRole(
  name: string,
  opts: { isFilter?: boolean; status?: 0 | 1; scopes?: string[]; menus: string[] }
): Promise<string> {
  await api.post("/api/v1/sys/roles", {
    code: uniqueCode("E2EDPR"),
    name,
    status: opts.status ?? 1,
    is_filter_scopes: opts.isFilter ?? true,
    remark: null,
  })
  const all = (await api.get("/api/v1/sys/roles/all")) as Array<{ id: string; name: string }>
  const role = all.find((r) => r.name === name)
  if (!role) throw new Error(`角色建完却找不到：${name}`)
  await api.put(`/api/v1/sys/roles/${role.id}/menus`, { menus: opts.menus })
  if (opts.scopes && opts.scopes.length > 0) {
    await api.put(`/api/v1/sys/roles/${role.id}/scopes`, { scopes: opts.scopes })
  }
  return role.id
}

/**
 * 「部门管理」那棵子树的菜单 id。
 *
 * 🔴 不能硬编码种子里的雪花 ID —— 那串数字只在这一份种子里成立（同 CLAUDE.md
 * 「部门与角色的编码」那节的理由）。按 `perms` / `path` 找。
 *
 * 为什么非要绑菜单：`/system/dept` 的路由守卫是 `requirePerm('sys:dept:add')`，
 * 权限码来自**角色菜单**。不绑的话每个测试账号打开部门页都会被重定向到 /403，
 * 测出来的「看不见任何部门」是假的 —— 它压根没进到那一页。
 */
async function deptMenuIds(): Promise<string[]> {
  type Node = { id: string; path: string | null; perms: string | null; children?: Node[] | null }
  const tree = (await api.get("/api/v1/sys/menus")) as Node[]
  const ids: string[] = []

  const collect = (n: Node): void => {
    ids.push(n.id)
    for (const c of n.children ?? []) collect(c)
  }
  const walk = (nodes: Node[], ancestors: string[]): void => {
    for (const n of nodes) {
      if (n.path === "/system/dept") {
        ids.push(...ancestors)
        collect(n)
        return
      }
      walk(n.children ?? [], [...ancestors, n.id])
    }
  }
  walk(tree, [])
  if (ids.length === 0) throw new Error("菜单树里找不到 /system/dept —— 种子数据的菜单结构改了？")
  return ids
}

test.beforeAll(async () => {
  const client = await createApiClient()
  api = client.api
  disposeApi = client.dispose

  g = { deptId: {} as Record<DeptKey, string>, scopeId: {}, roleId: {}, ruleIds: [], userId: {}, username: {} }

  // 部门
  for (const { key, parent } of DEPT_TREE) {
    await api.post("/api/v1/sys/depts", {
      code: deptCode(key),
      name: deptName(key),
      status: 1,
      sort: 0,
      parent_id: parent ? g.deptId[parent] : null,
    })
    const found = (await api.get(`/api/v1/sys/depts?code=${deptCode(key)}`)) as Array<{ id: string }>
    g.deptId[key] = found[0].id
  }

  const menus = await deptMenuIds()

  // 共用的「不过滤」角色 —— `mixed` 场景要拿它当那个"松"的角色
  const unfilteredRoleId = await createRole(`R${SFX}-UNFILT`, {
    isFilter: false,
    menus,
  })

  for (const s of SCENARIOS) {
    const ruleIds: string[] = []
    for (const [i, spec] of s.rules.entries()) ruleIds.push(await createRule(s.key, i, spec))

    const scopeId = await createScope(`E2E范围-${SFX}-${s.key}`, ruleIds, s.scopeStatus ?? 1)
    g.scopeId[s.key] = scopeId

    const roleId = await createRole(`R${SFX}-${s.key}`, {
      isFilter: s.isFilter ?? true,
      status: s.roleDisabled ? 0 : 1,
      // 没有规则的场景（noscope / uiflow）故意**不绑**范围，绑了就不是"没有范围"了
      scopes: s.key === "noscope" ? [] : [scopeId],
      menus,
    })
    g.roleId[s.key] = roleId

    const roles = [roleId]
    if (s.plusUnfilteredRole) roles.push(unfilteredRoleId)
    if (s.roleDisabled) {
      const fbRules: string[] = []
      for (const [i, spec] of (s.fallbackRules ?? []).entries()) {
        fbRules.push(await createRule(`${s.key}-fb`, i, spec))
      }
      const fbScope = await createScope(`E2E范围-${SFX}-${s.key}-fb`, fbRules)
      g.scopeId[`${s.key}-fb`] = fbScope
      roles.push(
        await createRole(`R${SFX}-${s.key}-fb`, { scopes: [fbScope], menus })
      )
    }

    const name = username(s.key)
    g.username[s.key] = name
    const user = (await api.post("/api/v1/sys/users", {
      username: name,
      password: PASSWORD,
      nickname: name,
      email: `${name}@e2e.example.com`,
      // dept_id 在创建接口上是**必填**，"没有部门"只能建完再改成 null
      dept_id: g.deptId[s.dept === undefined ? "A1" : (s.dept ?? "A1")],
      roles,
    })) as { id: string }
    g.userId[s.key] = user.id

    if (s.dept === null) {
      await api.put(`/api/v1/sys/users/${user.id}`, {
        username: name,
        nickname: name,
        email: `${name}@e2e.example.com`,
        phone: null,
        avatar: null,
        dept_id: null,
        roles,
      })
    }
  }
})

test.afterAll(async () => {
  if (!api) return
  // 顺序有讲究：用户挡着部门删不掉，子部门挡着父部门删不掉
  for (const id of Object.values(g.userId)) await api.del(`/api/v1/sys/users/${id}`).catch(() => {})
  const roleIds = Object.values(g.roleId)
  await api.del("/api/v1/sys/roles", { pks: roleIds }).catch(() => {})
  await api.del("/api/v1/sys/data-scopes", { pks: Object.values(g.scopeId) }).catch(() => {})
  await api.del("/api/v1/sys/data-rules", { pks: g.ruleIds }).catch(() => {})
  for (const k of ["A1", "A2", "B1", "RA", "RB", "OUT"] as DeptKey[]) {
    await api.del(`/api/v1/sys/depts/${g.deptId[k]}`).catch(() => {})
  }
  await disposeApi()
})

// --------------------------------------------------------------------------
// 断言helper
// --------------------------------------------------------------------------

function deptRow(page: Page, key: DeptKey) {
  return page.locator(DEPT_PANE).getByTestId(`dept-row-${deptName(key)}`)
}

/**
 * 打开部门页并断言可见集合。
 *
 * 🔴 **先断言"应该看见的"，再断言"不该看见的"**。反过来写就是假绿：
 * 骨架屏阶段所有行都不存在，`toHaveCount(0)` 会立刻通过 —— 页面还没加载完
 * 就判它"过滤生效了"。正向断言带自动重试，它一过就说明数据已经渲染完了。
 */
async function expectVisibleDepts(page: Page, expected: DeptKey[] | "all" | "none"): Promise<void> {
  await page.goto("/system/dept")
  await expect(page.locator(DEPT_PANE).getByTestId("page-title")).toHaveText("部门管理")

  if (expected === "none") {
    // 空态本身就是正向锚点，能等到它就说明列表已经加载完了
    await expect(page.locator(DEPT_PANE).getByTestId("dept-table")).toContainText("没有匹配的部门")
    for (const k of DEPT_KEYS) await expect(deptRow(page, k)).toHaveCount(0)
    return
  }

  const want = expected === "all" ? DEPT_KEYS : expected
  for (const k of want) await expect(deptRow(page, k)).toBeVisible()
  for (const k of DEPT_KEYS.filter((x) => !want.includes(x))) {
    await expect(deptRow(page, k)).toHaveCount(0)
  }
}

// --------------------------------------------------------------------------
// 1. 多账号可见性矩阵
// --------------------------------------------------------------------------

test.describe("数据权限 · 多账号可见性", () => {
  test("超级管理员看见全部（基线，没有它，下面那些「看不见」都不成立）", async ({ authedPage: page }) => {
    await expectVisibleDepts(page, "all")
  })

  for (const s of SCENARIOS.filter((x) => !x.manual)) {
    test(`${s.key}：${s.desc}`, async ({ page }) => {
      await loginPageAs(page, g.username[s.key], PASSWORD)
      await expectVisibleDepts(page, s.visible)
    })
  }
})

// --------------------------------------------------------------------------
// 2. 只有界面上才看得见的事
// --------------------------------------------------------------------------

test.describe("数据权限 · 界面语义", () => {
  test("🔴 父级被过滤掉时子部门会被提到顶层 —— 树的形状变了，接口测试看不出来", async ({ page }) => {
    // eq 场景只放行 A1，它的父级 RA 被滤掉了。
    // 后端 `traversal_to_tree` 找不到父节点就把子节点当根节点 append，
    // 于是界面上 A1 是一条**顶层行**：既没有上级、也没有任何展开/折叠按钮。
    await loginPageAs(page, g.username.eq, PASSWORD)
    await expectVisibleDepts(page, ["A1"])
    await expect(page.locator(DEPT_PANE).locator('[data-testid^="dept-toggle-"]')).toHaveCount(0)
  })

  test("AND / OR 混用时，数据权限页必须给出告警（这条语义只有界面替人看）", async ({ authedPage: page }) => {
    await page.goto(`/system/data-permission?scope=${g.scopeId.andor}`)
    await expect(page.getByTestId("scope-detail-name")).toHaveText(`E2E范围-${SFX}-andor`)
    await expect(page.getByTestId("rule-mixed-warn")).toBeVisible()
    await expect(page.getByTestId("rule-mixed-warn")).toContainText("绕过全部 AND 规则")

    // 反向对照：全 AND 的范围不该出现这条告警，否则它就成了永远亮着的噪音
    await page.goto(`/system/data-permission?scope=${g.scopeId.and2}`)
    await expect(page.getByTestId("rule-count")).toContainText("共 2 条规则")
    await expect(page.getByTestId("rule-mixed-warn")).toHaveCount(0)
  })

  test("范围停用时，规则列表上要挂「不生效」徽章", async ({ authedPage: page }) => {
    await page.goto(`/system/data-permission?scope=${g.scopeId.scopeoff}`)
    await expect(page.getByTestId("scope-disabled")).toBeVisible()
    await expect(page.getByTestId("rule-count")).toContainText("共 1 条规则")
  })

  test("角色关掉过滤开关时，「数据范围」tab 要说清楚绑了也不生效", async ({ authedPage: page }) => {
    await page.goto(`/system/role?role=${g.roleId.nofilter}&tab=scopes`)
    await expect(page.getByTestId("role-detail-name")).toHaveText(`R${SFX}-nofilter`)
    await expect(page.getByTestId("scope-inert")).toBeVisible()
    await expect(page.getByTestId("scope-inert")).toContainText("可以看到全量数据")

    // 反向对照：开着过滤的角色不该有这条提示
    await page.goto(`/system/role?role=${g.roleId.eq}&tab=scopes`)
    await expect(page.getByTestId("scope-count")).toBeVisible()
    await expect(page.getByTestId("scope-inert")).toHaveCount(0)
  })
})

// --------------------------------------------------------------------------
// 3. 配置链路（改了之后到底生不生效）
// --------------------------------------------------------------------------

test.describe("数据权限 · 配置链路", () => {
  test("🔴 在角色页解绑数据范围 → 目标账号**不重新登录**、刷新一下就变", async ({
    authedPage: adminPage,
    browser,
  }) => {
    const ctx = await browser.newContext()
    const userPage = await ctx.newPage()
    await loginPageAs(userPage, g.username.cachebust, PASSWORD)
    await expectVisibleDepts(userPage, ["A1"])

    // admin 在界面上把这个范围从角色上摘掉
    await adminPage.goto(`/system/role?role=${g.roleId.cachebust}&tab=scopes`)
    const check = adminPage.getByTestId(`scope-check-${g.scopeId.cachebust}`)
    await expect(check).toBeVisible()
    await check.click()
    await adminPage.getByTestId("scope-save").click()
    await expect(adminPage.getByTestId("scope-count")).toContainText("已绑定 0 /")

    // 用户那边**没有重新登录**，只是刷新。
    // 用户信息（含角色/范围/规则）整份缓存在 Redis 的 `fba:user:<id>` 里，
    // 服务端不主动清的话这里会原样返回旧结果 —— 而"改了权限要等一天才生效"
    // 是个不会报错、只会被当成"没保存上"的坑
    await expectVisibleDepts(userPage, "none")

    await ctx.close()
  })

  test("🔴 全链路：在数据权限页新建一条规则 → 目标账号刷新后立刻受限", async ({
    authedPage: adminPage,
    browser,
  }) => {
    const ctx = await browser.newContext()
    const userPage = await ctx.newPage()
    await loginPageAs(userPage, g.username.uiflow, PASSWORD)
    // 范围是空的（一条规则都没有）→ 看不见任何部门
    await expectVisibleDepts(userPage, "none")

    await adminPage.goto(`/system/data-permission?scope=${g.scopeId.uiflow}`)
    await expect(adminPage.getByTestId("rule-count")).toContainText("共 0 条规则")

    await adminPage.getByTestId("rule-add").click()
    await adminPage.getByTestId("dr-name").fill(`E2E规则-${SFX}-uiflow-ui`)
    await adminPage.getByTestId("dr-model").click()
    await adminPage.getByRole("option", { name: "Dept", exact: true }).click()
    // 选完模型字段才从下拉变成可选（没选模型时是个纯文本框）
    await adminPage.getByTestId("dr-column").click()
    await adminPage.getByRole("option", { name: /^code · / }).click()
    await adminPage.getByTestId("dr-value").fill(deptCode("A1"))
    await adminPage.getByTestId("dr-submit").click()

    // 建完自动挂到当前范围上 —— 这正是把两个菜单合并成主从页的理由，
    // 少了这一步就会留下一条谁也看不见的孤儿规则
    await expect(adminPage.getByTestId("rule-count")).toContainText("共 1 条规则")

    await expectVisibleDepts(userPage, ["A1"])

    // 这条规则是界面建的，`g.ruleIds` 里没有，afterAll 收不掉 —— 自己收
    const all = (await api.get("/api/v1/sys/data-rules/all")) as Array<{ id: string; name: string }>
    const created = all.find((r) => r.name === `E2E规则-${SFX}-uiflow-ui`)
    if (created) g.ruleIds.push(created.id)

    await ctx.close()
  })
})
