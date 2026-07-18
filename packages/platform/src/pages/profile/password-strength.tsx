import * as React from 'react'
import { IconCheck, IconMinus } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@admin/ui/lib/utils'

/**
 * 新密码的强度提示。
 *
 * ⚠️ **这里算的是「一般意义上的强度」，不是服务端的通过条件。**
 * 真正的规则在 `sys_config` 的口令策略里（最小/最大长度、复杂度、历史复用次数），
 * 由 `load_user_security_config` 在改密码路径上读取 —— 而 `GET /sys/configs`
 * 要 `sys:config:query` 权限，普通用户读不到，所以前端**没法**照着服务端的实际阈值校验。
 *
 * 结论就是两件事都要做，缺一个都不行：
 * 1. 这里给一个通用的强度反馈，让人在输入时就知道自己填得弱不弱
 *    （原来只有一句「强度规则由服务端口令策略决定」—— 告诉你有规则，但不告诉你是什么）
 * 2. 提交失败时**原样显示后端的报错**，不要在前端复刻一套规则去猜
 *    —— 复刻的那套一定会和 `sys_config` 里的真值漂移
 *
 * 所以这个条子**不参与**能不能提交的判定，它只是提示。
 */
type Rule = { id: string; label: string; ok: boolean }

const LEVELS = [
  { min: 0, label: '太弱', bar: 'bg-destructive', text: 'text-destructive' },
  { min: 2, label: '偏弱', bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  { min: 3, label: '中等', bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  { min: 4, label: '较强', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  { min: 5, label: '很强', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
] as const

export function PasswordStrength({ value, testId }: { value: string; testId?: string }) {
  const { t } = useTranslation()

  const rules: Rule[] = React.useMemo(
    () => [
      { id: 'len', label: '至少 8 位', ok: value.length >= 8 },
      { id: 'lower', label: '含小写字母', ok: /[a-z]/.test(value) },
      { id: 'upper', label: '含大写字母', ok: /[A-Z]/.test(value) },
      { id: 'digit', label: '含数字', ok: /\d/.test(value) },
      { id: 'symbol', label: '含符号', ok: /[^\w\s]/.test(value) },
    ],
    [value]
  )

  const score = rules.filter((r) => r.ok).length
  // 12 位以上再加一档 —— 长度对暴力破解的贡献比字符种类大
  const bumped = Math.min(5, value.length >= 12 ? score + 1 : score)
  const level = [...LEVELS].reverse().find((l) => bumped >= l.min) ?? LEVELS[0]

  if (!value) return null

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-3">
        {/* 5 段而不是一条渐变 —— 分段能看出「还差几档」，渐变只能看出「大概多少」 */}
        <div className="flex flex-1 gap-1" aria-hidden>
          {Array.from({ length: 5 }).map((_, i) => (
            <span
              key={i}
              className={cn('h-1 flex-1 rounded-full', i < bumped ? level.bar : 'bg-muted')}
            />
          ))}
        </div>
        <span className={cn('shrink-0 text-xs font-medium', level.text)} data-testid={testId ? `${testId}-level` : undefined}>
          {t(level.label)}
        </span>
      </div>

      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {rules.map((r) => (
          <li
            key={r.id}
            className={cn(
              'flex items-center gap-1 text-xs',
              r.ok ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {r.ok ? (
              <IconCheck className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <IconMinus className="size-3 shrink-0 text-muted-foreground" />
            )}
            {t(r.label)}
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        {t('这只是通用参考。能不能通过由服务端的口令策略决定，被拒时会显示具体原因。')}
      </p>
    </div>
  )
}
