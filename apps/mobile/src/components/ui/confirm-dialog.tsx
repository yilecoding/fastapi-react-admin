import { Portal } from '@rn-primitives/portal'
import * as React from 'react'
import { ActivityIndicator, BackHandler, Pressable, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Text } from '@/components/ui/text'

/**
 * 破坏性动作的确认框。**形状照 `packages/ui/src/components/confirm-dialog.tsx`
 * 抄**（`open` / `onOpenChange` / `title` / `description` / `confirmLabel` /
 * `cancelLabel` / `variant` / `onConfirm`），多一个 `busy`。
 *
 * 在这之前移动端**没有任何确认框**，所以 `(tabs)/profile.tsx` 的退出登录是
 * `onPress={() => void logout()}` —— **点到就走**。删除类操作一个都没有，
 * 因为没有可抄的形状。
 *
 * ## 🔴 为什么不用 react-native 的 `Modal`
 *
 * `Modal` 会把内容挂到**另一个原生根视图**上。uniwind 的令牌是 CSS 变量
 * （`--color-card` 那些），解析发生在 React 里，理论上跨 `Modal` 也成立 ——
 * 但这台机器上**没有能跑起来的设备**（模拟器还卡在 kvm 组，见 `scripts/` 分册），
 * 而这一类「样式在另一个原生根上失效」的问题**打包和 typecheck 全都不报**。
 *
 * 所以选了已经在用的那条路：`@rn-primitives/portal` 渲染进根 layout 的
 * `<PortalHost />`，**同一棵 React 树、同一个原生根**，令牌解析和普通屏一模一样。
 * 代价是 Android 返回键要自己接（见下），那是一件明确的、看得见的活。
 *
 * ⚠️ 等设备能跑起来了，这条判断要**实测**一次再改 —— 别因为「Modal 更标准」
 * 就换过去，换的是一个此刻无法验证的假设。
 *
 * ## 🔴 Android 的返回键必须接
 *
 * 走 portal 的浮层在原生看来只是一层普通 View，**返回键不会关它** ——
 * 会直接把当前屏 pop 掉，于是「按返回」= 确认框还开着、底下的屏却退了。
 * `Modal` 的 `onRequestClose` 白送这一条，portal 没有。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'destructive',
  busy = false,
  onConfirm,
  testID,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel: string
  cancelLabel: string
  variant?: 'default' | 'destructive'
  /** 确认后的操作还在飞：确认键转圈、遮罩和返回键都不再关它 */
  busy?: boolean
  onConfirm: () => void
  testID?: string
}) {
  React.useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // 🔴 返回 true = 「这个返回键我处理了」，阻止 expo-router 把屏 pop 掉。
      // busy 时也要返回 true —— 否则删除在飞、屏被退掉，回来之后列表还是旧的
      if (!busy) onOpenChange(false)
      return true
    })
    return () => sub.remove()
  }, [open, busy, onOpenChange])

  if (!open) return null

  return (
    <Portal name="confirm-dialog">
      <View className="absolute inset-0 z-40 items-center justify-center p-6" testID={testID}>
        {/* 遮罩。点它关掉 —— iOS/Android 都是这个约定 */}
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={() => {
            if (!busy) onOpenChange(false)
          }}
        />
        <View className="bg-card border-border w-full max-w-[400px] gap-1 rounded-2xl border p-5 shadow-xl shadow-black/20">
          <Text className="text-[17px] font-semibold">{title}</Text>
          {description ? (
            <Text className="text-muted-foreground text-[14px] leading-5">{description}</Text>
          ) : null}
          {/* 按钮竖排：手机上并排两个按钮容易误触，而且长文案会挤成两行 */}
          <View className="gap-2 pt-4">
            <Button
              variant={variant}
              disabled={busy}
              onPress={onConfirm}
              testID={testID ? `${testID}-confirm` : undefined}
              className="h-[46px] rounded-xl"
            >
              {busy ? <ActivityIndicator size="small" color="#fff" /> : null}
              <Text className="text-[15px] font-semibold">{confirmLabel}</Text>
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onPress={() => onOpenChange(false)}
              testID={testID ? `${testID}-cancel` : undefined}
              className="h-[46px] rounded-xl"
            >
              <Text className="text-[15px]">{cancelLabel}</Text>
            </Button>
          </View>
        </View>
      </View>
    </Portal>
  )
}
