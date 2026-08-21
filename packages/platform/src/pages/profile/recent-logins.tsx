import { IconAlertTriangle, IconHistory, IconRefresh } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'
import { Skeleton } from '@admin/ui/components/skeleton'

import { formatLocation } from '../_shared/login-log'
import { StatusPill } from '../_shared/status'
import { myLoginHistoryQuery, RECENT_LOGIN_LIMIT } from './api'

/**
 * 「你的账号最近在这些地方登录过」。
 *
 * 为什么值得单独做一块：这是安全设置里唯一能让人**自己发现异常**的东西 ——
 * 改密码和绑第三方都是「我主动做的事」，只有登录记录能回答「有没有别人用过我的号」。
 * 失败的那几条尤其重要（有人在试你的密码）。
 *
 * ⚠️ 不做分页、不做筛选。要查全量去「日志管理 → 登录日志」，那边是审计视图。
 * 这里只有最近 {@link RECENT_LOGIN_LIMIT} 条，多了就变成第二个日志页了。
 *
 * ⚠️ 取数的坑（`username` 是 LIKE 不是全等）在 `api.ts` 的 `myLoginHistoryQuery` 里写着。
 */
export function RecentLogins({ username }: { username?: string }) {
  const { t } = useTranslation()
  const { data, isPending, error, refetch, isFetching } = useQuery(myLoginHistoryQuery(username))

  return (
    <div className="flex flex-col gap-3">
      {/* 标题这一行要和 `profile/index.tsx` 的 `Block` 长一样（图标装淡底方块），
          否则安全面板里三块有两块带徽标、这块光秃秃 */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-content-center rounded-md bg-primary/10 text-primary">
            <IconHistory className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold">{t('最近登录')}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {t('最近 {{n}} 次登录尝试。看到不是自己的记录，立刻改密码。', { n: RECENT_LOGIN_LIMIT })}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t('刷新')}
          disabled={isFetching}
          data-testid="p-logins-refresh"
          onClick={() => void refetch()}
        >
          <IconRefresh className={isFetching ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      {/* 内容缩进与 Block 对齐（图标 28px + gap 10px），见 profile/index.tsx 的 Block */}
      <div className="flex flex-col gap-3 sm:ps-[2.375rem]">
      {/* 失败必须是可见状态而不是缺失状态 —— 静默隐藏等于把服务端错误
          伪装成「这个功能不存在」（CLAUDE.md 硬纪律 9） */}
      {error ? (
        <p
          className="flex items-center gap-1.5 text-sm text-destructive"
          data-testid="p-logins-error"
        >
          <IconAlertTriangle className="size-3.5 shrink-0" />
          {t('登录记录读取失败')}
        </p>
      ) : isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : !data?.length ? (
        <p className="text-sm text-muted-foreground" data-testid="p-logins-empty">
          {t('还没有登录记录')}
        </p>
      ) : (
        <ul className="flex flex-col" data-testid="p-logins">
          {data.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0"
            >
              <div className="flex min-w-0 flex-col">
                {/* 直接显示后端给的字符串，和登录日志页一致。
                    不走 formatTime/formatDate：`login_time` 是不带时区标记的
                    "2026-08-21 09:16:35"，交给 `new Date()` 解析是按本地时区猜的，
                    对不对取决于浏览器 —— 安全信息上不该有这种不确定性 */}
                <span className="font-mono text-xs tabular-nums">{r.login_time}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {/* IP 与归属地对「是不是我」最有判断力，浏览器/系统次之 */}
                  <span className="font-mono">{r.ip}</span>
                  {' · '}
                  {formatLocation(r)}
                  {r.browser && ` · ${r.browser}`}
                  {r.os && ` · ${r.os}`}
                </span>
              </div>
              <StatusPill tone={r.status === 1 ? 'success' : 'danger'}>
                {r.status === 1 ? t('成功') : t('失败')}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
      </div>
    </div>
  )
}
