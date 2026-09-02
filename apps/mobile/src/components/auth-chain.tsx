import * as React from 'react'
import { Animated, Easing, View } from 'react-native'
import { useCSSVariable } from 'uniwind'

import { Text } from '@/components/ui/text'

/**
 * 权限链 —— 登录页的 hero。
 *
 * 这是 web 登录页左栏那张示意图（`_guest/-sign-in-brand.tsx` 的 `AuthChain`）
 * 竖过来的版本：一条导轨，四级挂在上面，一道主色脉冲从上往下跑。
 *
 * **为什么这个能当 hero**：它画的就是这个产品本身 —— 用户经角色拿到菜单/按钮，
 * 同一次授权还决定看得到哪些数据行。登录页放一张「产品是什么」的图，
 * 比放一句标语实在。
 *
 * 🔴 **`01`–`04` 这几个编号是有意义的，不是装饰** —— 这条链真有先后。
 * 别处不要摆编号（那是最常见的一种假结构）。
 */
const RAIL_LEFT = 3
const ROW_H = 54

const STAGES = [
  { index: '01', label: '用户', caption: '谁在登录' },
  { index: '02', label: '角色', caption: '授权的单位' },
  { index: '03', label: '菜单 · 按钮', caption: '能进哪、能点哪' },
  { index: '04', label: '数据范围', caption: '能看到哪些行' },
] as const

export function AuthChain() {
  const height = ROW_H * STAGES.length
  const t = React.useRef(new Animated.Value(0)).current

  React.useEffect(() => {
    // 一道从上往下的脉冲，2.9s 一轮 —— 周期和 web 的 `.tenon-flow` 一致。
    // ⚠️ 位移用 useNativeDriver，别在 JS 线程上逐帧算。
    const loop = Animated.loop(
      Animated.timing(t, { toValue: 1, duration: 2900, easing: Easing.linear, useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [t])

  return (
    <View style={{ height }} className="relative">
      {/* 导轨 */}
      <View className="bg-line absolute top-1 bottom-1 w-px" style={{ left: RAIL_LEFT }} />

      {/* 脉冲：一小段主色亮线沿导轨下行 */}
      <Animated.View
        pointerEvents="none"
        className="bg-accent absolute w-px"
        style={{
          left: RAIL_LEFT,
          height: 26,
          opacity: t.interpolate({ inputRange: [0, 0.08, 0.9, 1], outputRange: [0, 1, 1, 0] }),
          transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, height - 26] }) }],
        }}
      />

      {STAGES.map((st, i) => (
        <View key={st.index} style={{ height: ROW_H }} className="flex-row items-start gap-3.5">
          {/* 节点：空心小方块坐在导轨上，最后一级用实心 —— 链到这里结束 */}
          <View
            className={i === STAGES.length - 1 ? 'bg-accent' : 'bg-panel border-dim border'}
            style={{ width: 7, height: 7, borderRadius: 1, marginTop: 5, marginLeft: 0 }}
          />
          <View className="flex-1 flex-row items-baseline gap-2.5">
            <Text className="text-faint font-mono text-[10px]" style={{ letterSpacing: 1.6 }}>
              {st.index}
            </Text>
            <View className="flex-1">
              <Text className="text-ink text-[15px] font-medium">{st.label}</Text>
              <Text className="text-faint mt-0.5 text-[12px]">{st.caption}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  )
}

/** 让 `bg-panel` 那个空心节点在深色下也能读出来 —— 取的是同一个令牌，不写死 */
export function useRailColors() {
  const line = useCSSVariable('--color-line')
  return { line: typeof line === 'string' ? line : undefined }
}
