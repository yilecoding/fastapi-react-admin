/**
 * Playground 的演示数据 —— 1000 行，纯前端生成。
 *
 * 用固定种子的线性同余生成器而不是 `Math.random()`：
 * 数据每次刷新都一样，截图对比和「这个 bug 在第 37 行」这种描述才有意义。
 */

export type DemoRow = {
  id: string
  name: string
  account: string
  email: string
  team: string
  city: string
  role: string
  status: 0 | 1 | 2
  score: number
  amount: number
  lastLoginAt: string
  createdAt: string
}

const SURNAMES = ['林', '陈', '周', '许', '沈', '顾', '陆', '苏', '程', '秦', '何', '钱', '曹', '袁', '邓']
const GIVEN = ['舟', '曜', '澈', '安', '南', '白', '川', '禾', '述', '屿', '砚', '珩', '桥', '野', '决']
const TEAMS = ['平台体验组', '交易增长组', '风险策略组', '客户运营组', '基础架构组', '数据平台组']
const CITIES = ['上海', '杭州', '深圳', '北京', '广州', '成都', '南京', '武汉']
const ROLES = ['管理员', '开发者', '运营', '审计员', '只读']
const STATUS: DemoRow['status'][] = [1, 1, 1, 0, 2]

/** 32 位线性同余，参数取自 Numerical Recipes */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function pad(n: number, w = 4) {
  return String(n).padStart(w, '0')
}

/** 生成 ISO 风格的本地时间串。基准时间写死，不用 Date.now() —— 同样是为了可复现 */
function stamp(baseDay: number, offsetDays: number, hour: number) {
  const base = Date.UTC(2025, 0, 1) + (baseDay + offsetDays) * 86400_000 + hour * 3600_000
  const d = new Date(base)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`
}

export function makeDemoRows(count = 1000): DemoRow[] {
  const rnd = lcg(20260821)
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const surname = SURNAMES[Math.floor(rnd() * SURNAMES.length)]!
    const given = GIVEN[Math.floor(rnd() * GIVEN.length)]!
    const team = TEAMS[Math.floor(rnd() * TEAMS.length)]!
    const city = CITIES[Math.floor(rnd() * CITIES.length)]!
    const role = ROLES[Math.floor(rnd() * ROLES.length)]!
    const status = STATUS[Math.floor(rnd() * STATUS.length)]!
    return {
      id: String(n),
      name: `${surname}${given} ${pad(n)}`,
      account: `user.${pad(n)}`,
      email: `user.${pad(n)}@panis.dev`,
      team,
      city,
      role,
      status,
      score: Math.round(rnd() * 1000) / 10,
      amount: Math.round(rnd() * 98000) + 2000,
      lastLoginAt: stamp(Math.floor(rnd() * 300), 0, 8 + Math.floor(rnd() * 10)),
      createdAt: stamp(Math.floor(rnd() * 200), 0, 9 + Math.floor(rnd() * 8)),
    }
  })
}

export const STATUS_META: Record<number, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
  1: { label: '启用', tone: 'success' },
  0: { label: '停用', tone: 'danger' },
  2: { label: '待激活', tone: 'warning' },
}
