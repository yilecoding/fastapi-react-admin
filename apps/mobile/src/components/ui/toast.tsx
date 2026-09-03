import { Portal } from '@rn-primitives/portal'
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, XIcon, type LucideIcon } from 'lucide-react-native'
import * as React from 'react'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { cn } from '@/lib/utils'

/**
 * Toast —— **写操作的反馈通道**。
 *
 * ## 为什么要有它：读失败和写失败不是一回事
 *
 * 硬纪律 9 说「请求失败必须是可见状态」，但**可见的形式**分两种，混用哪一种
 * 都会坏：
 *
 * | | 反馈形式 | 为什么 |
 * |---|---|---|
 * | **拉取**失败（列表 / 详情） | 屏内的错误块 + 重试按钮 | 那一整块内容本来就没有，错误要**占住它的位置**；toast 飘走之后屏上是一片空，和「没有数据」分不清 |
 * | **写**失败（删除 / 保存） | toast | 屏上的内容是对的（还是修改前那份），没有位置可占；而且写操作往回跳屏（`router.back()`），屏内错误跟着卸载就等于没报 |
 *
 * web 那边是同一个分工（拉取走 `QueryError`、mutation 走全局 toast，见 #51）。
 * 移动端在这之前**只有前一半** —— 于是三个屏各写了一段 inline 错误
 * （`profile/edit.tsx` / `profile.tsx` / `notifications.tsx`），而删除类操作
 * 一个都没有，因为没地方报。
 *
 * ## 形状照 `packages/ui/src/components/toast.tsx` 抄，实现独立
 *
 * `toast.success()` / `.error()` / `.info()` / `.warning()` / `.dismiss()`
 * 与 web 同名同形（「抄形状不抄实现」）。**没有** `loading` / `promise` /
 * `update` —— 那三个是给「长任务 + 原地变结果态」用的，移动端这一版没有
 * 那种场景，加了就是没人用的代码。
 *
 * ⚠️ 与 web 的一处**刻意不同**：web 的错误 toast 是 `timeout: 0`（不自动消失，
 * 理由是「一条自己溜走的报错等于没报」）。移动端保留这条，但**必须给出退出口**
 * —— 手机上一条不会走的横幅会一直压着内容，而没有 hover 这回事。
 * 所以错误 toast 上有一枚 ✕，整条也可以点掉。
 *
 * 🔴 **命令式 API 必须能在 React 之外调用**（mutation 的 `onError` 里），
 * 所以状态在模块级的 store 里，组件用 `useSyncExternalStore` 订阅。
 * 写成 context + hook 的话 `onError` 里拿不到。
 */

export type ToastTone = 'message' | 'info' | 'success' | 'warning' | 'error'

type ToastItem = {
  id: string
  tone: ToastTone
  title: string
  description?: string
  /** 0 = 不自动消失 */
  timeout: number
}

type Options = {
  description?: string
  /** 0 = 不自动消失。错误类默认就是 0 */
  timeout?: number
}

let items: ToastItem[] = []
let seq = 0
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit() {
  // 🔴 必须换数组引用 —— `useSyncExternalStore` 用 `Object.is` 比快照，
  // 原地 push 的话订阅者一次都不会重渲染（静默：toast 进了 store、屏上没有）
  items = [...items]
  listeners.forEach((l) => l())
}

function dismiss(id?: string) {
  if (id === undefined) {
    timers.forEach((tm) => clearTimeout(tm))
    timers.clear()
    items = []
    emit()
    return
  }
  const tm = timers.get(id)
  if (tm) {
    clearTimeout(tm)
    timers.delete(id)
  }
  items = items.filter((x) => x.id !== id)
  emit()
}

function push(tone: ToastTone, title: string, opts: Options = {}): string {
  const id = `t${++seq}`
  // 错误默认不自动消失（同 web）。其余 3.5 秒 —— 移动端比 web 短一点，
  // 因为它压在内容上、而手机屏本来就窄
  const timeout = opts.timeout ?? (tone === 'error' ? 0 : 3500)
  items = [...items, { id, tone, title, description: opts.description, timeout }]
  // ⚠️ 同时最多留 3 条：移动端屏窄，第 4 条一来最早那条就该走，
  // 否则整块横幅能盖掉半屏
  if (items.length > 3) {
    const overflow = items.slice(0, items.length - 3)
    overflow.forEach((x) => {
      const tm = timers.get(x.id)
      if (tm) clearTimeout(tm)
      timers.delete(x.id)
    })
    items = items.slice(-3)
  }
  if (timeout > 0) timers.set(id, setTimeout(() => dismiss(id), timeout))
  emit()
  return id
}

export const toast = {
  /** 中性通知，不带语气色 */
  message: (title: string, opts?: Options) => push('message', title, opts),
  info: (title: string, opts?: Options) => push('info', title, opts),
  success: (title: string, opts?: Options) => push('success', title, opts),
  warning: (title: string, opts?: Options) => push('warning', title, opts),
  /** ⚠️ 默认**不**自动消失，见文件头注释 */
  error: (title: string, opts?: Options) => push('error', title, opts),
  /** 关掉某一条；不传 id 关掉全部 */
  dismiss,
}

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  message: InfoIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: CircleAlertIcon,
  error: CircleAlertIcon,
}

/**
 * 语气色。
 *
 * ⚠️ `success` / `warning` 用的是 Tailwind 自带色阶而不是令牌 —— 设计令牌里
 * **只有** `destructive` 一个语气色（`global.css` 里没有 `--color-success`）。
 * 要么在两个语言里各造一个令牌，要么在这里用色阶；选后者，因为造令牌就要
 * 同时改 web 的 `globals.css`，那是另一件事。**这是唯一一处例外**，
 * 别照着它在别处写死颜色。
 */
const TONE_CLASS: Record<ToastTone, string> = {
  message: 'text-muted-foreground',
  info: 'text-primary',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

function snapshot() {
  return items
}

/**
 * Toast 的宿主。挂在**根 layout 里、`<PortalHost />` 之后** ——
 * 它自己走 `<Portal>`，所以渲染进 PortalHost 那个容器，天然盖在所有屏之上
 * （包括推在 Stack 上的屏和 `Modal`）。
 *
 * 🔴 只能挂一个。挂两个的话每条 toast 会显示两遍。
 */
export function Toaster() {
  const list = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  const insets = useSafeAreaInsets()

  if (list.length === 0) return null

  return (
    <Portal name="toaster">
      {/*
        ⚠️ `pointerEvents="box-none"` 是关键：容器铺满整屏，不写这一句的话
        它会吃掉**整屏**的触摸，屏上任何东西都点不动 —— 而且只在有 toast
        的那几秒里发生，很难和「界面卡住」区分开。
      */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 top-0 z-50 gap-2 px-4"
        style={{ paddingTop: insets.top + 8 }}
      >
        {list.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => dismiss(item.id)}
            className="bg-card border-border flex-row items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-lg shadow-black/10"
          >
            <Icon as={TONE_ICON[item.tone]} className={cn('mt-0.5 size-[18px]', TONE_CLASS[item.tone])} />
            <View className="flex-1 gap-0.5">
              <Text className="text-[14px] font-medium">{item.title}</Text>
              {item.description ? (
                <Text className="text-muted-foreground text-[12px] leading-4">{item.description}</Text>
              ) : null}
            </View>
            {/* 不自动消失的那条要有一枚看得见的退出口 */}
            {item.timeout === 0 ? <Icon as={XIcon} className="text-muted-foreground mt-0.5 size-4" /> : null}
          </Pressable>
        ))}
      </View>
    </Portal>
  )
}
