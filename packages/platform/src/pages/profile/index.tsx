import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle, IconAt, IconCheck, IconClock, IconExternalLink, IconIdBadge2,
  IconInfoCircle, IconKey, IconLoader2, IconMail, IconPhoto, IconPlugConnected,
  IconShieldLock, IconSignature, IconUpload, IconUser,
} from '@tabler/icons-react'

import { BASE_TIME_ZONE, formatDateTime } from '@admin/i18n'
import { Avatar, AvatarFallback, AvatarImage } from '@admin/ui/components/avatar'
import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Combobox, type ComboboxOption } from '@admin/ui/components/combobox'
import { Input } from '@admin/ui/components/input'
import { Label } from '@admin/ui/components/label'
import { Skeleton } from '@admin/ui/components/skeleton'

import { usePreferencePanels } from '../_shared/preferences-panel'
import { SettingsShell, type SettingsPanel } from '../_shared/settings-shell'

import { endSession } from '../../api-client/client'
import { ApiError } from '../../api-client/errors'
import { meQuery, type CurrentUser } from '../../auth/queries'
import { PageHeader } from '../../shell/page-header'
import { StatusBadge, StatusPill } from '../_shared/status'
import { PasswordStrength } from './password-strength'
import { RecentLogins } from './recent-logins'
import {
  AVATAR_MAX_BYTES, SOCIAL_SOURCES, socialBindingsQuery, useSendEmailCaptcha,
  useSaveTimeZone, useSocialBindingUrl, useUnbindSocial, useUpdateAvatar, useUpdateEmail,
  useUpdateNickname, useUpdatePassword, useUploadAvatar, type SocialSource,
} from './api'

/**
 * 个人中心。
 *
 * 对应后端的 `PUT /sys/users/me/{nickname,avatar,email,password}` 四个接口 ——
 * 在这一页之前，界面上**没有任何改自己密码的入口**。
 *
 * ## 版式：一条竖导航 + 切换面板，内容列封顶
 *
 * 第一版是「顶部三个页签，页签内容铺满整宽，偏好页签里再套一条左栏」。
 * 三个实测出来的问题：
 *
 * 1. **两层导航管 8 个小节。** 想调标签页外观得先点「偏好设置」页签、再点左栏
 *    「多标签页」—— 而 GitHub / Linear / Zapier 的账号设置都是一条竖导航到底。
 * 2. **一行不成为一个视觉单元。** 内容铺满 1072px，`SettingRow` 的文字列 `flex-1`
 *    撑满，控件被顶到最右：1600px 视口下「标签文字 → 控件」实测 602~954px
 *    （平均 845px）。开关行最惨 —— 44px 的小开关钉在 954px 之外。
 * 3. **看不出这是谁的页面。** 顶上只有三个页签，没有头像也没有名字。
 *
 * 现在：左栏一层（账号/外观/其他 三组六项）→ 内容列封顶 40rem → 顶部身份区。
 * 当前面板走 `search.section` 进 URL（原来的 `tab` 参数已经删掉，不做兼容 ——
 * 见 CLAUDE.md「还没发版」）。
 *
 * ## 硬纪律
 *
 * - 组件 router-独立：`section` 只走 props，页面内不读路由
 * - 草稿一律写成 `draft ?? 服务端值` 两层，不要 `useEffect` 把服务端数据 setState
 *   进草稿 —— 后台 refetch 一回来就会冲掉用户没保存的输入
 * - 面板切换靠 `<Activity>` 保活（在 `SettingsShell` 里），所以切走再切回来，
 *   没提交的昵称/邮箱/密码还在。原来靠的是 `<TabsContent keepMounted>`
 */
export type ProfileSearch = {
  /** 当前面板 */
  section?: ProfileSection
}

/** 前两项是账号相关，后四项来自 `usePreferencePanels()` */
type ProfileSection = 'basic' | 'security' | 'theme' | 'layout' | 'tabs' | 'reset'

const errMsg = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : fallback

export function ProfilePage({
  search = {},
  onSearchChange,
}: {
  search?: ProfileSearch
  onSearchChange?: (next: ProfileSearch) => void
}) {
  const { t } = useTranslation()
  const { data: me, isPending } = useQuery(meQuery)
  const preferencePanels = usePreferencePanels()

  const panels: SettingsPanel[] = React.useMemo(
    () => [
      {
        id: 'basic',
        group: t('账户'),
        label: t('资料'),
        icon: <IconIdBadge2 />,
        content: <BasicPanel me={me} loading={isPending} />,
      },
      {
        id: 'security',
        group: t('账户'),
        label: t('安全'),
        icon: <IconShieldLock />,
        content: <SecurityPanel me={me} />,
      },
      ...preferencePanels,
    ],
    [me, isPending, preferencePanels, t]
  )

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
        <PageHeader title={t('个人中心')} description={t('维护自己的资料与登录密码')} />
        <SettingsShell
          panels={panels}
          value={search.section ?? 'basic'}
          onChange={(id) => onSearchChange?.({ ...search, section: id as ProfileSection })}
          header={<IdentityHeader me={me} loading={isPending} />}
          testId="profile"
        />
      </div>
    </div>
  )
}

/* ────────────────────────── 身份区 ────────────────────────── */

/**
 * 「这是谁的页面」。
 *
 * 所有参考产品（GitHub / Zapier / Bitly）的账号设置都先交代身份 —— 头像 + 名字
 * + 身份标签。原来这一页完全没有，进来只看到三个页签。
 *
 * 数据全部来自 `meQuery`，不需要额外接口。
 */
function IdentityHeader({ me, loading }: { me?: CurrentUser; loading: boolean }) {
  const { t } = useTranslation()

  if (loading || !me) {
    return (
      <div
        className="flex items-center gap-4 rounded-xl bg-muted/40 p-5"
        data-testid="profile-identity"
      >
        <Skeleton className="size-16 shrink-0 rounded-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-5 w-52" />
        </div>
      </div>
    )
  }

  return (
    // 横幅：主色渐变淡底 + 右侧点阵。**没有边框** —— 用色块本身划出这一块，
    // 比再画一道 ring 干净。渐变往右淡出到透明，所以右边缘不需要收口
    <div
      className="relative overflow-hidden rounded-xl bg-gradient-to-r from-primary/12 via-primary/5 to-transparent p-5"
      data-testid="profile-identity"
    >
      {/* 装饰点阵。纯 CSS（`radial-gradient` 平铺）而不是图片：不新增静态资源、
          跟着主色走、深色模式自动跟着 `--primary` 变。`mask` 让它往左淡出，
          不会压到文字上 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 end-0 w-1/2 opacity-[0.18]"
        style={{
          backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
          backgroundSize: '10px 10px',
          color: 'var(--primary)',
          maskImage: 'linear-gradient(to right, transparent, black)',
          WebkitMaskImage: 'linear-gradient(to right, transparent, black)',
        }}
      />
      <div className="relative flex items-center gap-4">
        {/* 圆角方形而不是圆形 —— 和站内其它头像（侧边栏、顶栏那两个圆形小头像）
            区分开：这里是「本人主体」，不是列表里的一个条目 */}
        {/* ⚠️ `rounded-xl` 之外**必须**再写 `after:rounded-xl`。`Avatar` 的基础类里
            有一层 `after:` 伪元素画描边，它自己带 `after:rounded-full` ——
            前缀不同就不算冲突，twMerge 不会消解，两条都留在 class 里，
            于是根节点是圆角方形、描边还是个圆，看起来就是「没生效」
            （CLAUDE.md「为什么有些覆盖有效、有些无声失效」那一节） */}
        <Avatar className="size-16 shrink-0 rounded-xl ring-1 ring-primary/20 after:rounded-xl">
          {me.avatar && <AvatarImage src={me.avatar} alt={me.nickname} className="rounded-xl" />}
          <AvatarFallback className="rounded-xl bg-primary/15 text-lg font-semibold text-primary">
            {me.nickname?.slice(0, 1) || <IconUser className="size-6" />}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-2">
          {/* 一行交代「是谁、在哪」，一行交代「有什么身份」。
              部门跟在用户名后面而不是单独占一行 —— 单独一行又是最小号字，
              位置在最下面，读起来像事后补上去的 */}
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate text-xl font-semibold" data-testid="profile-nickname-display">
              {me.nickname}
            </span>
            <span className="font-mono text-sm text-muted-foreground" data-testid="profile-username">
              {me.username}
            </span>
            {me.dept && <span className="text-sm text-muted-foreground">· {me.dept}</span>}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge value={me.status} />
            {me.is_superuser && <Badge>{t('超管')}</Badge>}
            {/* 接口给的是角色**名称**数组，没有 id —— 用名字当 key */}
            {me.roles?.map((name) => (
              <Badge key={name} variant="secondary">{name}</Badge>
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────── 公共件 ────────────────────────── */

/**
 * 面板内的一块。
 *
 * 裸 section 而不是 Card —— 卡片框由 `SettingsShell` 在**面板**这一层统一给一个。
 * 一块一卡会变成「资料面板 4 张卡、外观面板 0 张卡」，切导航时框忽有忽无。
 */
function Block({
  title,
  description,
  icon,
  children,
  testId,
}: {
  title: string
  description?: React.ReactNode
  /** 块标题左侧的图标。和左栏图标一起，让一屏里「哪块是哪块」不用读字 */
  icon?: React.ReactNode
  children: React.ReactNode
  testId?: string
}) {
  return (
    <section
      className="flex flex-col gap-3 border-b border-border/60 pb-6 last:border-0 last:pb-0"
      data-testid={testId}
    >
      <div className="flex items-start gap-2.5">
        {icon && (
          // 图标装在一个淡底方块里 —— 裸图标和标题文字同色同重，糊成一团；
          // 有个底之后它是「块的徽标」，扫一眼就知道分了几块
          <span className="mt-0.5 grid size-7 shrink-0 place-content-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
            {icon}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {/* 内容缩进到**和标题文字**对齐（图标 28px + gap 10px = 38px）。
          不缩进的话标题比它下面的输入框右移 38px，一屏扫下来每块都有一处
          错位的左边缘。窄屏不缩进 —— 那时 38px 是实打实的可用宽度 */}
      <div className="sm:ps-[2.375rem]">{children}</div>
    </section>
  )
}

/** 每块自己的提交状态条。没有 toast，反馈只能内联。 */
function StatusLine({ state, okText }: { state: CardState; okText: string }) {
  if (state.kind === 'error') {
    return (
      <p className="flex items-center gap-1.5 text-sm text-destructive" data-testid="card-error">
        <IconAlertTriangle className="size-3.5 shrink-0" />
        {state.msg}
      </p>
    )
  }
  if (state.kind === 'ok') {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400"
         data-testid="card-ok">
        <IconCheck className="size-3.5 shrink-0" />
        {okText}
      </p>
    )
  }
  return null
}

type CardState = { kind: 'idle' } | { kind: 'ok' } | { kind: 'error'; msg: string }
const IDLE: CardState = { kind: 'idle' }

function SubmitButton({
  pending, disabled, children, testid, className,
}: {
  pending: boolean
  disabled: boolean
  children: React.ReactNode
  testid: string
  className?: string
}) {
  return (
    <Button type="submit" size="sm" className={className} disabled={disabled || pending} data-testid={testid}>
      {pending && <IconLoader2 className="size-4 animate-spin" />}
      {children}
    </Button>
  )
}

/* ────────────────────────── 面板：资料 ────────────────────────── */

function BasicPanel({ me, loading }: { me?: CurrentUser; loading: boolean }) {
  return (
    <>
      <NicknameBlock me={me} />
      <AvatarBlock me={me} />
      <EmailBlock me={me} />
      <TimeZoneBlock me={me} />
      <ReadOnlyBlock me={me} loading={loading} />
    </>
  )
}

/**
 * 显示时区。
 *
 * 放在**资料**面板而不是「外观」那一组下自成一节 —— 它只有一个控件，
 * 单独占一条竖导航项，点进去一眼看完就得退出来。而且它和下面「其他信息」里的
 * 注册时间/上次登录是同一件事：那两行的渲染就依赖这个值，挨着放能当场看到效果。
 *
 * ⚠️ 它和同面板其他块的**存储位置不同**：昵称/头像/邮箱和它一样都存服务端，
 * 但「外观」那一组（主题/圆角/标签条）存 localStorage。判据是这个设置描述的是
 * **人**还是**设备** —— 见 [shell 分册](../../shell/AGENTS.md) 的「例外：时区存服务端」。
 */
function TimeZoneBlock({ me }: { me?: CurrentUser }) {
  const { t } = useTranslation()
  const save = useSaveTimeZone()
  const [state, setState] = React.useState<CardState>(IDLE)

  // 400+ 项，只在挂载时算一次。`hint` 放该时区**此刻**的偏移和钟点 ——
  // 光看 `America/Argentina/Salta` 是不知道自己该不该选它的。
  const options = React.useMemo<ComboboxOption[]>(() => {
    const zones =
      typeof Intl.supportedValuesOf === 'function'
        ? Intl.supportedValuesOf('timeZone')
        : [BASE_TIME_ZONE]
    const now = Date.now()
    return zones.map((z) => ({ value: z, label: z, hint: zoneOffsetHint(now, z) }))
  }, [])

  const browserZone = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return null
    }
  }, [])

  async function pick(v: string | null) {
    if (!v || v === me?.timezone) return
    setState(IDLE)
    try {
      await save.mutateAsync(v)
      setState({ kind: 'ok' })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('时区更新失败')) })
    }
  }

  return (
    <Block
      title={t('时区')}
      description={t('只影响界面上时间怎么显示。日志记的时刻、定时任务什么时候跑都不受它影响')}
      icon={<IconClock />}
      testId="profile-timezone"
    >
      <div className="flex flex-col gap-2">
        <Combobox
          value={me?.timezone ?? null}
          onValueChange={(v) => void pick(v)}
          options={options}
          disabled={!me || save.isPending}
          data-testid="p-timezone"
          placeholder={t('选择时区')}
          searchPlaceholder={t('搜索时区，如 Tokyo')}
          className="w-full max-w-md"
        />
        {browserZone && me?.timezone && browserZone !== me.timezone && (
          <p className="text-xs text-muted-foreground" data-testid="p-timezone-mismatch">
            {t('这台设备的系统时区是 {{zone}}，和上面选的不一致 —— 界面按上面选的显示。', {
              zone: browserZone,
            })}
          </p>
        )}
        <StatusLine state={state} okText={t('时区已更新')} />
      </div>
    </Block>
  )
}

/** 该时区此刻的偏移 + 钟点，如 `GMT+9 · 18:20` */
function zoneOffsetHint(now: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
    const at = (k: string) => parts.find((p) => p.type === k)?.value ?? ''
    return `${at('timeZoneName')} · ${at('hour')}:${at('minute')}`
  } catch {
    // 浏览器不认这个时区就不给提示，但**仍然把它列出来**（列表本来就来自
    // supportedValuesOf，理论上走不到这里）
    return ''
  }
}

/**
 * 只能由管理员改的字段。
 *
 * 放在资料面板**最后**：它是只读的，读它的频率远低于改昵称/头像/邮箱。
 * 原来它是第一张卡（左上角），把三个可编辑项挤到了右边和下面。
 * 用户名、角色、状态、部门已经上移到身份区，这里只剩真正的「其他」。
 */
function ReadOnlyBlock({ me, loading }: { me?: CurrentUser; loading: boolean }) {
  const { t } = useTranslation()
  return (
    <Block
      title={t('其他信息')}
      description={t('这些字段只能由管理员在「用户管理」里改')}
      icon={<IconInfoCircle />}
      testId="profile-account"
    >
      {loading || !me ? (
        <p className="text-sm text-muted-foreground">{t('加载中…')}</p>
      ) : (
        <div className="flex flex-col">
          <InfoRow label={t('手机号')}>
            {me.phone || <span className="text-muted-foreground">—</span>}
          </InfoRow>
          <InfoRow label={t('注册时间')}>
            <span className="font-mono text-xs tabular-nums">{formatDateTime(me.join_time)}</span>
          </InfoRow>
          <InfoRow label={t('上次登录')}>
            <span className="font-mono text-xs tabular-nums">{formatDateTime(me.last_login_time)}</span>
          </InfoRow>
        </div>
      )}
    </Block>
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 text-end text-sm">{children}</span>
    </div>
  )
}

/* ────────────────────────── 昵称 ────────────────────────── */

function NicknameBlock({ me }: { me?: CurrentUser }) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<string | null>(null)
  const [state, setState] = React.useState<CardState>(IDLE)
  const mut = useUpdateNickname()

  const value = draft ?? me?.nickname ?? ''      // 两层：草稿优先，没草稿才看服务端
  const trimmed = value.trim()
  // 值没变就禁用：后端 rowcount = 0 会被 handler 判成 fail，那是个假失败
  const unchanged = !me || trimmed === me.nickname
  const invalid = trimmed.length === 0 || trimmed.length > 64

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setState(IDLE)
    try {
      await mut.mutateAsync(trimmed)
      setDraft(null)
      setState({ kind: 'ok' })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('昵称保存失败')) })
    }
  }

  return (
    <Block
      title={t('昵称')}
      description={t('侧边栏和操作日志里显示的名字')}
      icon={<IconSignature />}
      testId="profile-nickname"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {/* 输入框和保存按钮同一行 —— 一个 64 字上限的短字段不值得占两行。
            原来是「输入框一行、按钮一行、旁边再一句『与当前一致，无需保存』」，
            那句话是在给一个禁用的按钮做旁白，删掉：按钮灰着本身就是答案 */}
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Input
              id="p-nickname" data-testid="p-nickname" value={value} maxLength={64}
              aria-label={t('昵称')}
              onChange={(e) => { setDraft(e.target.value); setState(IDLE) }}
            />
            {invalid && trimmed.length > 0 && (
              <p className="text-sm text-destructive">{t('昵称不能超过 64 个字符')}</p>
            )}
          </div>
          <SubmitButton pending={mut.isPending} disabled={unchanged || invalid} testid="p-nickname-save">
            {t('保存')}
          </SubmitButton>
        </div>
        <StatusLine state={state} okText={t('昵称已更新')} />
      </form>
    </Block>
  )
}

/* ────────────────────────── 头像 ────────────────────────── */

function AvatarBlock({ me }: { me?: CurrentUser }) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<string | null>(null)
  const [state, setState] = React.useState<CardState>(IDLE)
  const [showUrl, setShowUrl] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement | null>(null)
  const mut = useUpdateAvatar()
  const up = useUploadAvatar()

  const value = draft ?? me?.avatar ?? ''
  const trimmed = value.trim()
  const unchanged = !me || trimmed === (me.avatar ?? '')
  // 后端字段是 HttpUrl，只收完整地址；本地相对路径会被 422 挡回来
  const invalid = trimmed.length > 0 && !/^https?:\/\/\S+$/i.test(trimmed)

  async function pick(file: File | undefined) {
    if (!file) return
    setState(IDLE)
    // 先在前端挡两道，别把注定被拒的字节传一遍。服务端仍是权威
    if (!file.type.startsWith('image/')) {
      setState({ kind: 'error', msg: t('只能上传图片') })
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setState({ kind: 'error', msg: t('图片不能超过 {{n}} MB', { n: AVATAR_MAX_BYTES / 1024 / 1024 }) })
      return
    }
    try {
      await up.mutateAsync(file)
      setDraft(null)
      setState({ kind: 'ok' })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('头像上传失败')) })
    } finally {
      // 清空 input，否则连续选同一个文件不会再触发 change
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function submitUrl(e: React.FormEvent) {
    e.preventDefault()
    setState(IDLE)
    try {
      await mut.mutateAsync(trimmed)
      setDraft(null)
      setState({ kind: 'ok' })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('头像保存失败')) })
    }
  }

  const busy = up.isPending || mut.isPending

  return (
    <Block
      title={t('头像')}
      description={t('上传一张图片，或粘贴一个已有的图片地址')}
      icon={<IconPhoto />}
      testId="profile-avatar"
    >
      <div className="flex flex-col gap-3">
        {/* 主入口是**上传**，不是粘地址。粘 URL 那条留着（有些人就是想引用外链），
            但收进「或粘贴图片地址」这个次级入口里 —— 让人先看到能上传 */}
        <div className="flex items-center gap-4">
          <Avatar className="size-16 shrink-0 rounded-xl after:rounded-xl">
            {trimmed && !invalid && <AvatarImage src={trimmed} alt={t('头像预览')} className="rounded-xl" />}
            <AvatarFallback className="rounded-xl">
              <IconUser className="size-6 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="p-avatar-file"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <Button
              type="button" variant="outline" size="sm" disabled={busy}
              data-testid="p-avatar-upload"
              onClick={() => fileRef.current?.click()}
            >
              {up.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconUpload className="size-4" />}
              {t('上传图片')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('JPG / PNG / WebP，不超过 {{n}} MB', { n: AVATAR_MAX_BYTES / 1024 / 1024 })}
            </span>
          </div>
        </div>

        <StatusLine state={state} okText={t('头像已更新')} />

        {showUrl ? (
          <form onSubmit={submitUrl} className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Input
                id="p-avatar" data-testid="p-avatar" value={value} placeholder="https://…"
                aria-label={t('头像地址')}
                onChange={(e) => { setDraft(e.target.value); setState(IDLE) }}
              />
              {invalid && <p className="text-sm text-destructive">{t('请填完整的 http(s) 地址')}</p>}
            </div>
            <SubmitButton pending={mut.isPending} disabled={unchanged || invalid} testid="p-avatar-save">
              {t('保存')}
            </SubmitButton>
          </form>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            data-testid="p-avatar-url-toggle"
            onClick={() => setShowUrl(true)}
          >
            {t('或粘贴图片地址')}
          </button>
        )}
      </div>
    </Block>
  )
}

/* ────────────────────────── 邮箱 ────────────────────────── */

function EmailBlock({ me }: { me?: CurrentUser }) {
  const { t } = useTranslation()
  const [email, setEmail] = React.useState('')
  const [captcha, setCaptcha] = React.useState('')
  const [state, setState] = React.useState<CardState>(IDLE)
  const [sent, setSent] = React.useState<CardState>(IDLE)
  const send = useSendEmailCaptcha()
  const mut = useUpdateEmail()

  const trimmed = email.trim()
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
  const same = me?.email ? trimmed === me.email : false

  async function sendCode() {
    setSent(IDLE)
    setState(IDLE)
    try {
      await send.mutateAsync(trimmed)
      setSent({ kind: 'ok' })
    } catch (err) {
      // SMTP 没配就会失败 —— 必须显示出来，否则用户对着永远填不对的验证码框发呆
      setSent({ kind: 'error', msg: errMsg(err, t('验证码发送失败，请检查邮件服务配置')) })
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setState(IDLE)
    try {
      await mut.mutateAsync({ email: trimmed, captcha: captcha.trim() })
      setEmail('')
      setCaptcha('')
      setSent(IDLE)
      setState({ kind: 'ok' })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('邮箱更新失败')) })
    }
  }

  return (
    <Block
      title={t('邮箱')}
      description={
        <>
          {t('当前：')}
          <span className="font-mono" data-testid="p-email-current">
            {me?.email || t('未绑定')}
          </span>
        </>
      }
      icon={<IconAt />}
      testId="profile-email"
    >
      {/*
        两行共用**同一套栅格列**（`1fr` + 固定 8.5rem 的动作列），所以两个按钮
        左右边缘都对齐。原来第一行是 `flex-1` 输入框、第二行是 `w-32` 验证码框，
        两个按钮各自贴在自己那行的右边 —— 一个在 1090px、一个在 630px，
        右边缘参差，中间还空出一大块，是这一块最难看的地方。

        验证码只有 6 位，所以它不占满整个 `1fr` 格，而是在格子里左对齐给 `w-36`：
        格子对齐保证按钮成列，框宽仍按内容给。
      */}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-[minmax(0,1fr)_8.5rem] items-end gap-x-2 gap-y-1.5">
          <Label htmlFor="p-email" className="col-span-2">{t('新邮箱')}</Label>
          <Input
            id="p-email" data-testid="p-email" value={email}
            placeholder="you@example.com" autoComplete="email"
            onChange={(e) => { setEmail(e.target.value); setState(IDLE); setSent(IDLE) }}
          />
          <Button
            type="button" variant="outline" size="sm" className="w-full"
            data-testid="p-email-send"
            disabled={!emailOk || same || send.isPending}
            onClick={() => void sendCode()}
          >
            {send.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconMail className="size-4" />}
            {t('发送验证码')}
          </Button>

          <Label htmlFor="p-email-captcha" className="col-span-2 mt-1.5">{t('邮箱验证码')}</Label>
          <Input
            id="p-email-captcha" data-testid="p-email-captcha" value={captcha} maxLength={6}
            inputMode="numeric" className="w-36 font-mono tracking-widest"
            onChange={(e) => { setCaptcha(e.target.value); setState(IDLE) }}
          />
          <SubmitButton
            pending={mut.isPending}
            disabled={!emailOk || same || captcha.trim().length === 0}
            testid="p-email-save"
            className="w-full"
          >
            {t('绑定新邮箱')}
          </SubmitButton>
        </div>
        {same && <p className="text-sm text-muted-foreground">{t('与当前邮箱一致')}</p>}
        <StatusLine state={sent} okText={t('验证码已发往该邮箱，10 分钟内有效')} />
        <StatusLine state={state} okText={t('邮箱已更新')} />
      </form>
    </Block>
  )
}

/* ────────────────────────── 面板：安全 ────────────────────────── */

function SecurityPanel({ me }: { me?: CurrentUser }) {
  return (
    <>
      <PasswordBlock />
      <SocialBlock />
      {/* 最近登录放最后：前两块是「我主动改什么」，这块是「有没有人动过我的号」，
          属于事后核查。数据源和坑见 `recent-logins.tsx`。
          标题和说明由 RecentLogins 自己带（它右上角还有个刷新按钮），所以不套 Block */}
      <section
        className="flex flex-col gap-3 border-b border-border/60 pb-6 last:border-0 last:pb-0"
        data-testid="profile-logins"
      >
        <RecentLogins username={me?.username} />
      </section>
    </>
  )
}

/* ────────────────────────── 密码 ────────────────────────── */

function PasswordBlock() {
  const { t } = useTranslation()
  const [oldPwd, setOldPwd] = React.useState('')
  const [newPwd, setNewPwd] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [state, setState] = React.useState<CardState>(IDLE)
  // 改密码成功后服务端会把本人的 token 全删掉，所以这里倒计时后主动登出。
  // 不这么做的话，用户会在下一个请求 401 时被莫名弹回登录页。
  const [bye, setBye] = React.useState<number | null>(null)
  const mut = useUpdatePassword()

  React.useEffect(() => {
    if (bye === null) return
    if (bye <= 0) { endSession(); return }
    // 不要把它命名成 t —— 会遮蔽翻译函数
    const timer = setTimeout(() => setBye(bye - 1), 1000)
    return () => clearTimeout(timer)
  }, [bye])

  const mismatch = confirm.length > 0 && newPwd !== confirm
  const sameAsOld = newPwd.length > 0 && newPwd === oldPwd
  const ready = oldPwd.length > 0 && newPwd.length > 0 && confirm.length > 0 && !mismatch && !sameAsOld

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setState(IDLE)
    try {
      await mut.mutateAsync({ old_password: oldPwd, new_password: newPwd, confirm_password: confirm })
      setOldPwd(''); setNewPwd(''); setConfirm('')
      setState({ kind: 'ok' })
      setBye(3)
    } catch (err) {
      // 长度/复杂度/历史密码复用的规则都在服务端（读 sys_config），
      // 客户端不复刻，直接把后端的话原样显示
      setState({ kind: 'error', msg: errMsg(err, t('密码修改失败')) })
    }
  }

  return (
    <Block title={t('修改密码')} icon={<IconKey />} testId="profile-password">
      <form onSubmit={submit} className="flex flex-col gap-3">
        {/* ⚠️ 宽度上限放在**这一层**，不是逐个输入框上写 `max-w-72`。
            逐个写的话强度条会按整块（640px）铺开，而它解释的那个输入框只有 288px ——
            条子比框长出一倍，看着不像同一件东西。整列同宽，条子和框才对齐。
            密码框本来就不该铺满：它是短字段，框宽对输入没有任何帮助 */}
        <div className="flex max-w-sm flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-old">{t('当前密码')}</Label>
            <Input id="p-old" data-testid="p-old" type="password" value={oldPwd}
                   autoComplete="current-password"
                   onChange={(e) => { setOldPwd(e.target.value); setState(IDLE) }} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-new">{t('新密码')}</Label>
            <Input id="p-new" data-testid="p-new" type="password" value={newPwd}
                   autoComplete="new-password"
                   onChange={(e) => { setNewPwd(e.target.value); setState(IDLE) }} />
            {sameAsOld && <p className="text-sm text-destructive">{t('新密码不能与当前密码相同')}</p>}
            {/* 强度条只是提示，不参与能不能提交的判定 —— 真规则在服务端，见组件注释 */}
            <PasswordStrength value={newPwd} testId="p-strength" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-confirm">{t('确认新密码')}</Label>
            <Input id="p-confirm" data-testid="p-confirm" type="password" value={confirm}
                   autoComplete="new-password"
                   onChange={(e) => { setConfirm(e.target.value); setState(IDLE) }} />
            {mismatch && (
              <p className="text-sm text-destructive" data-testid="p-mismatch">{t('两次输入的密码不一致')}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SubmitButton pending={mut.isPending} disabled={!ready || bye !== null} testid="p-password-save">
            {t('修改密码')}
          </SubmitButton>
          {bye === null ? (
            <StatusLine state={state} okText={t('密码已修改')} />
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400"
               data-testid="p-password-bye">
              <IconCheck className="size-3.5 shrink-0" />
              {t('密码已修改，需要用新密码重新登录（{{n}} 秒后跳转）', { n: bye })}
            </p>
          )}
        </div>
      </form>
    </Block>
  )
}

/* ────────────────────────── 社交账号绑定 ────────────────────────── */

/**
 * 第三方账号绑定（oauth2 插件）。
 *
 * 放在「安全」而不是「资料」：绑定第三方等于多开了一条登录入口，
 * 属于安全面而不是资料面。
 *
 * ⚠️ 这一块只能把跳转做对，**跳过去之后能不能成，取决于服务端配置**：
 * `OAUTH2_*_CLIENT_ID` 现在是占位值 `test`，跳过去会被对方直接拒绝。
 * 与其让用户跳出去撞一堵墙再回来猜，不如在按钮旁边先说清楚。
 * （回跳地址曾经也是错的 —— 指向 5173 而前端在 5174；现在两边都是 1125 了。
 *   `OAUTH2_FRONTEND_*_REDIRECT_URI` 在 `plugin/oauth2/plugin.toml`，
 *   改前端端口时要一起改。）
 */
function SocialBlock() {
  const { t } = useTranslation()
  const { data: bound = [], isPending, error } = useQuery(socialBindingsQuery)
  const [state, setState] = React.useState<CardState>(IDLE)
  const [busy, setBusy] = React.useState<SocialSource | null>(null)
  const getUrl = useSocialBindingUrl()
  const unbind = useUnbindSocial()

  async function bind(source: SocialSource) {
    setState(IDLE)
    setBusy(source)
    // ⚠️ 必须**先同步开窗**再去取 URL。
    // `window.open` 只在用户手势的同步调用栈里被允许；等 await 回来再开，
    // 浏览器已经不认这是用户发起的，弹窗会被静默拦截（实测就是这么挂的）。
    // 所以先开一个空白页占住许可，拿到地址后再把它导过去。
    // ⚠️ 不能传 `noopener` —— 带上它 `window.open` 会**返回 null**（引用被切断），
    // 我们就拿不到句柄去设置地址，代码会掉进兜底分支把**主页面**导航走。
    // 正确做法是照常开窗拿句柄，再手动把 opener 置空拿回同样的安全性。
    const w = window.open('', '_blank')
    if (w) w.opener = null
    try {
      const url = await getUrl.mutateAsync(source)
      if (w) {
        w.location.href = url
      } else {
        // 弹窗被浏览器全局拦截了 —— 退化成当前页跳转，总比点了没反应强
        window.location.href = url
      }
    } catch (err) {
      w?.close()
      setState({ kind: 'error', msg: errMsg(err, t('取授权链接失败')) })
    } finally {
      setBusy(null)
    }
  }

  async function drop(source: SocialSource) {
    setState(IDLE)
    setBusy(source)
    try {
      await unbind.mutateAsync(source)
      setState({ kind: 'ok' })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('解绑失败')) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Block
      title={t('第三方账号')}
      description={t('绑定后可用该账号直接登录')}
      icon={<IconPlugConnected />}
      testId="profile-social"
    >
      <div className="flex flex-col gap-3">
        {error ? (
          // 插件被停用时接口会 404 —— 说清楚是「没启用」而不是「坏了」
          <p className="text-sm text-muted-foreground" data-testid="social-unavailable">
            {t('社交登录不可用（oauth2 插件未启用或接口异常）。')}
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {SOCIAL_SOURCES.map(({ source, label }) => {
              const on = bound.includes(source)
              const working = busy === source
              return (
                <div key={source} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="flex items-center gap-2 text-sm">
                    {label}
                    {isPending ? (
                      <span className="text-xs text-muted-foreground">…</span>
                    ) : on ? (
                      <StatusPill tone="success">{t('已绑定')}</StatusPill>
                    ) : (
                      <StatusPill tone="muted">{t('未绑定')}</StatusPill>
                    )}
                  </span>
                  {on ? (
                    <Button
                      variant="outline" size="sm" disabled={working}
                      data-testid={`social-unbind-${source}`}
                      onClick={() => void drop(source)}
                    >
                      {working && <IconLoader2 className="size-4 animate-spin" />}
                      {t('解绑')}
                    </Button>
                  ) : (
                    <Button
                      variant="outline" size="sm" disabled={working}
                      data-testid={`social-bind-${source}`}
                      onClick={() => void bind(source)}
                    >
                      {working ? <IconLoader2 className="size-4 animate-spin" /> : <IconExternalLink className="size-4" />}
                      {t('绑定')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <StatusLine state={state} okText={t('已解绑')} />

        <p className="text-xs text-muted-foreground" data-testid="social-hint">
          <Trans
            t={t}
            i18nKey="绑定会新开一页跳到对方的授权页。需要服务端先配好 <c>OAUTH2_*_CLIENT_ID / SECRET</c> 与回调地址；没配好时对方会直接拒绝，这一页帮不上忙。"
            components={{ c: <code className="mx-1 font-mono" /> }}
          />
        </p>
      </div>
    </Block>
  )
}
