import { t } from '@admin/i18n'

import { isGroupSwitch, isSecret, type ConfigItem } from './api'

/**
 * 配置项元数据注册表。
 *
 * 为什么必须有这张表：后端 `sys_config` 只有
 * `name / type / key / value / is_frontend / remark` 六个字段，**没有控件类型、
 * 没有小节、没有顺序、没有取值范围、没有依赖关系**。想把这一页做成「设计过的
 * 设置屏」而不是键值对表格，这些信息只能在前端补。
 *
 * 三条规则：
 * 1. 注册表**只是增强**。命中不了的键回落到类型推断（见 `api.ts: valueKind`）
 *    并落进「未纳管的键」小节 —— 后端加一个键永远不会把这一页弄坏
 * 2. `label` 会覆盖库里的 `name`。库里三条总开关的 name 都叫「状态」，
 *    在分组头上显示「状态」等于没说
 * 3. `validate` 不是锦上添花，是**必须**的 —— 见下面那段
 *
 * ⚠️ 校验为什么是必须的（实测）：
 * 后端 `utils/dynamic_config.py` 的 converter 是裸 `int`，而
 * `load_user_security_config` 挂在**登录和改密码路径**上。把
 * `USER_PASSWORD_MIN_LENGTH` 清空（number 输入框按退格就到）并保存，
 * 下一次登录就是
 * `500 invalid literal for int() with base 10: ''` —— 全站登录挂掉，包括你自己。
 * 这一页是唯一会写这张表的界面，所以它必须自己兜住。
 */

export type Widget = 'switch' | 'switch01' | 'int' | 'text' | 'secret'

export type SettingMeta = {
  /** 所属小节标题（分组页内的段落） */
  section: string
  /** 小节内顺序。不给顺序就会退化成键名字母序，相关项会被打散 */
  order: number
  /** 覆盖库里的 name */
  label?: string
  /** 完整说明。库里的 remark 只有零星几条，而且是「0 表示禁用锁定」这种半句话 */
  hint?: string
  /** 数值单位，显示在输入框右侧 */
  unit?: string
  /** 强制控件类型（不给则按值推断） */
  widget?: Widget
  min?: number
  max?: number
  /** 改动会放宽安全边界 —— 行上标记 + 保存确认框里单独列出 */
  danger?: boolean
  /**
   * 依赖判定：返回「不可用的原因」，返回 null 表示可用。
   * 例：锁定阈值为 0 时，锁定时长填什么都没意义
   */
  disabledBy?: (get: (key: string) => string) => string | null
}

const int = (v: string) => Number.parseInt(v, 10)

export const REGISTRY: Record<string, SettingMeta> = {
  // ── 开发工具 ───────────────────────────────────────────────────────────────
  DEV_CONFIG_STATUS: {
    section: '开发工具',
    order: 0,
    label: '开发配置总开关',
    hint: '关掉后整组开发配置都不生效。注意它是 1/0，不是 true/false',
    widget: 'switch01',
  },
  DEV_SANDBOX_ENABLED: {
    section: '开发工具',
    order: 1,
    label: '组件沙箱',
    hint: '是否露出「开发工具 › 组件沙箱」。关掉后那一页会说明原因，不是 403',
  },

  // ── 登录策略 ───────────────────────────────────────────────────────────────
  LOGIN_CAPTCHA_ENABLED: {
    section: '登录校验',
    order: 1,
    label: '图形验证码',
    hint: '关闭后登录不再要求验证码，暴力破解的门槛会显著降低',
    danger: true,
  },

  // ── 口令强度 ───────────────────────────────────────────────────────────────
  USER_PASSWORD_MIN_LENGTH: {
    section: '口令强度',
    order: 1,
    label: '最小长度',
    unit: '位',
    widget: 'int',
    min: 1,
    max: 128,
    danger: true,
  },
  USER_PASSWORD_MAX_LENGTH: {
    section: '口令强度',
    order: 2,
    label: '最大长度',
    unit: '位',
    widget: 'int',
    min: 1,
    max: 128,
  },
  USER_PASSWORD_REQUIRE_SPECIAL_CHAR: {
    section: '口令强度',
    order: 3,
    label: '必须包含特殊字符',
    hint: '要求密码里至少有一个非字母数字字符',
    danger: true,
  },

  // ── 有效期与提醒 ───────────────────────────────────────────────────────────
  USER_PASSWORD_EXPIRY_DAYS: {
    section: '有效期与提醒',
    order: 1,
    label: '密码有效期',
    unit: '天',
    widget: 'int',
    min: 0,
    max: 3650,
    hint: '0 表示永不过期',
    danger: true,
  },
  USER_PASSWORD_REMINDER_DAYS: {
    section: '有效期与提醒',
    order: 2,
    label: '到期提醒提前量',
    unit: '天',
    widget: 'int',
    min: 0,
    max: 365,
    hint: '登录时提示密码即将过期；0 表示不提醒',
    disabledBy: (get) => (int(get('USER_PASSWORD_EXPIRY_DAYS')) === 0 ? t('密码永不过期，提醒不会触发') : null),
  },
  USER_PASSWORD_HISTORY_CHECK_COUNT: {
    section: '有效期与提醒',
    order: 3,
    label: '历史密码检查',
    unit: '次',
    widget: 'int',
    min: 0,
    max: 24,
    hint: '改密码时禁止与最近这么多个旧密码重复；0 表示不检查',
    danger: true,
  },

  // ── 账号锁定 ───────────────────────────────────────────────────────────────
  USER_LOCK_THRESHOLD: {
    section: '账号锁定',
    order: 1,
    label: '连续失败阈值',
    unit: '次',
    widget: 'int',
    min: 0,
    max: 100,
    hint: '密码连续错这么多次后锁定账号；0 表示禁用锁定',
    danger: true,
  },
  USER_LOCK_SECONDS: {
    section: '账号锁定',
    order: 2,
    label: '锁定时长',
    unit: '秒',
    widget: 'int',
    min: 1,
    max: 86400,
    danger: true,
    disabledBy: (get) => (int(get('USER_LOCK_THRESHOLD')) === 0 ? t('失败阈值为 0，锁定已禁用') : null),
  },

  // ── 邮件服务 ───────────────────────────────────────────────────────────────
  EMAIL_HOST: { section: '服务器', order: 1, label: 'SMTP 地址' },
  EMAIL_PORT: { section: '服务器', order: 2, label: '端口', widget: 'int', min: 1, max: 65535 },
  EMAIL_SSL: { section: '服务器', order: 3, label: 'SSL 加密', hint: '465 端口通常需要开启' },
  EMAIL_USERNAME: { section: '认证', order: 1, label: '发信账号' },
  EMAIL_PASSWORD: {
    section: '认证',
    order: 2,
    label: '发信密码',
    widget: 'secret',
    hint: '多数邮箱这里填的是「授权码」而不是登录密码',
  },
}

export const metaOf = (key: string): SettingMeta | undefined => REGISTRY[key]

export const UNMANAGED_SECTION = '未纳管的键'

/**
 * 小节的显示顺序。
 *
 * 必须显式给 —— 否则顺序会跟着 `sys_config` 的行顺序走（接口按 id 排，
 * 也就是种子插入顺序），于是「账号锁定」会排在「口令强度」前面，
 * 而且换一批种子数据顺序就变了。表里没有的小节排在「未纳管」之前。
 */
export const SECTION_ORDER: string[] = [
  '开发工具',
  '登录校验',
  '口令强度',
  '有效期与提醒',
  '账号锁定',
  '服务器',
  '认证',
]

export function sectionRank(section: string): number {
  if (section === UNMANAGED_SECTION) return SECTION_ORDER.length + 1
  const i = SECTION_ORDER.indexOf(section)
  return i < 0 ? SECTION_ORDER.length : i
}

// ─── 左栏导航 ─────────────────────────────────────────────────────────────────

export type RailItem = {
  /** 与 `sys_config.type` 对应；'other' 是兜底桶 */
  id: string
  label: string
  desc: string
}

export type RailGroup = { title: string; items: RailItem[] }

/**
 * 左栏结构。刻意**不是**由 `type` 直接生成 —— 那样只会得到四个平铺的英文枚举值。
 * 分类归属和文案是产品决定，跟着这张表走；`type` 只是数据键。
 */
export const RAIL: RailGroup[] = [
  {
    title: '安全策略',
    items: [
      { id: 'LOGIN', label: '登录策略', desc: '登录流程的开关。改动立刻对所有人生效。' },
      { id: 'USER_SECURITY', label: '口令与锁定', desc: '口令强度、有效期与账号锁定策略。放宽会直接降低抗暴力破解能力。' },
    ],
  },
  {
    title: '通知与集成',
    items: [{ id: 'EMAIL', label: '邮件服务', desc: '系统发信用的 SMTP 服务器。密码以密文展示。' }],
  },
  {
    title: '高级',
    items: [
      { id: 'AI', label: 'AI', desc: '预留分组。' },
      {
        id: 'DEV',
        label: '开发',
        desc: '开发期用的东西。这一组不影响业务，但会决定「开发工具」那些页面露不露出来。',
      },
      { id: 'other', label: '未纳管的键', desc: '注册表里没有描述的键（含未分组）。控件按值推断，改动请自行确认语义。' },
    ],
  },
]

/** 某条配置归到左栏的哪一项 */
export function railIdOf(item: ConfigItem): string {
  // 局部变量不能叫 t —— 会遮蔽本模块导入的翻译函数
  const type = item.type
  if (type && RAIL.some((g) => g.items.some((i) => i.id === type))) return type
  return 'other'
}

export const railItem = (id: string): RailItem | undefined =>
  RAIL.flatMap((g) => g.items).find((i) => i.id === id)

// ─── 校验 ─────────────────────────────────────────────────────────────────────

/**
 * 单项校验。返回错误文案，null 表示通过。
 *
 * 注意 `int` 类**空值也要拦**：`''` 落库后后端 `int('')` 会抛 ValueError，
 * 而那行代码在登录路径上。
 */
export function validateOne(item: ConfigItem, value: string): string | null {
  const meta = metaOf(item.key)
  const widget = meta?.widget

  if (widget === 'int' || (!widget && /^-?\d+$/.test(item.value) && !isSecret(item.key))) {
    if (value.trim() === '') return t('不能为空')
    if (!/^-?\d+$/.test(value.trim())) return t('只能填整数')
    const n = Number(value)
    if (meta?.min !== undefined && n < meta.min) return t('不能小于 {{min}}', { min: meta.min })
    if (meta?.max !== undefined && n > meta.max) return t('不能大于 {{max}}', { max: meta.max })
    return null
  }

  if (isGroupSwitch(item.key) && value !== '0' && value !== '1') return t('总开关只能是 0 或 1')
  if (value.length > 2000) return t('太长了（上限 2000 字符）')
  return null
}

/**
 * 跨字段校验。单项校验管不了「最小长度 99 > 最大长度 32」这种 ——
 * 实测那个组合能存进去、不报错，只是从此所有人都改不了密码。
 */
export function validateCross(get: (key: string) => string | undefined): Record<string, string> {
  const errs: Record<string, string> = {}
  const num = (k: string) => {
    const v = get(k)
    return v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : null
  }

  const min = num('USER_PASSWORD_MIN_LENGTH')
  const max = num('USER_PASSWORD_MAX_LENGTH')
  if (min !== null && max !== null && min > max) {
    errs.USER_PASSWORD_MIN_LENGTH = t('不能大于最大长度（{{max}}）', { max })
    errs.USER_PASSWORD_MAX_LENGTH = t('不能小于最小长度（{{min}}）', { min })
  }

  const expiry = num('USER_PASSWORD_EXPIRY_DAYS')
  const remind = num('USER_PASSWORD_REMINDER_DAYS')
  if (expiry !== null && expiry > 0 && remind !== null && remind > expiry) {
    errs.USER_PASSWORD_REMINDER_DAYS = t('提前量不能超过有效期（{{n}} 天）', { n: expiry })
  }

  return errs
}

// ─── 小节摘要（参照图右侧那行灰字的等价物） ───────────────────────────────────

/**
 * 把一个小节的当前取值说成人话。
 *
 * 参照产品在控件右上角放的是「蓝色 / 嵌入式 / 当前控件 24px」这种当前值回显；
 * 我们的参数是策略型的，单个值回显没意义（输入框里就写着），
 * 组合起来的**效果**才是人要确认的东西。
 */
export function sectionSummary(section: string, get: (key: string) => string | undefined): string | null {
  const n = (k: string) => {
    const v = get(k)
    return v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : null
  }
  const b = (k: string) => get(k) === 'true'

  if (section === '账号锁定') {
    // 局部变量不能叫 t —— 会遮蔽翻译函数（CLAUDE.md 里记过一次同样的坑）
    const th = n('USER_LOCK_THRESHOLD')
    const s = n('USER_LOCK_SECONDS')
    if (th === 0) return t('已禁用 —— 密码错多少次都不锁账号')
    if (th === null || s === null) return null
    const human = s % 60 === 0 ? t('{{n}} 分钟', { n: s / 60 }) : t('{{n}} 秒', { n: s })
    return t('连续错 {{n}} 次 → 锁定 {{human}}', { n: th, human })
  }

  if (section === '有效期与提醒') {
    const d = n('USER_PASSWORD_EXPIRY_DAYS')
    const r = n('USER_PASSWORD_REMINDER_DAYS')
    const h = n('USER_PASSWORD_HISTORY_CHECK_COUNT')
    const tail = h ? t('，禁止与最近 {{n}} 个旧密码重复', { n: h }) : ''
    if (d === 0) return t('密码永不过期{{tail}}', { tail })
    if (d === null) return null
    const remind = r ? t('，提前 {{n}} 天提醒', { n: r }) : t('，不提醒')
    return t('{{d}} 天后过期{{remind}}{{tail}}', { d, remind, tail })
  }

  if (section === '口令强度') {
    const min = n('USER_PASSWORD_MIN_LENGTH')
    const max = n('USER_PASSWORD_MAX_LENGTH')
    if (min === null || max === null) return null
    const special = b('USER_PASSWORD_REQUIRE_SPECIAL_CHAR') ? t('必须') : t('不要求')
    return t('{{min}}–{{max}} 位，{{special}}含特殊字符', { min, max, special })
  }

  if (section === '服务器') {
    const host = get('EMAIL_HOST')
    const port = get('EMAIL_PORT')
    if (!host || !port) return null
    return `${host}:${port}${b('EMAIL_SSL') ? t('（SSL）') : t('（明文）')}`
  }

  if (section === '登录校验') {
    return b('LOGIN_CAPTCHA_ENABLED') ? t('登录需要图形验证码') : t('登录不需要验证码')
  }

  return null
}
