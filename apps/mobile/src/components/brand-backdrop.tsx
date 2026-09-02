import { View } from 'react-native'
import Svg, { Defs, LinearGradient, Line, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg'
import { useCSSVariable } from 'uniwind'

/**
 * 品牌底纹 —— web 端登录页左栏那块面板的移动端版。
 *
 * 两层：38px 方格（图纸感）+ 左上角一团主色辉光（给面板一个光源方向）。
 *
 * 🔴 **渐隐必须是竖向线性的，不能用径向。** 第一版用了 web 那边的
 * `radial-gradient` mask，在手机的窄长比例下那个圆的边界会在屏幕中间
 * **压出一条清晰的横带**，看着像渲染坏了。竖向线性从上到下退掉就没有边界。
 *
 * ⚠️ web 那边还有第三层胶片颗粒（`feTurbulence`）。`react-native-svg` 的
 * filter 支持不全，这里**没做** —— 缺了它面板会平一点，但不会错。
 */
export function BrandBackdrop({ className }: { className?: string }) {
  const accent = useCSSVariable('--color-accent')
  const line = useCSSVariable('--color-line')
  const panel = useCSSVariable('--color-panel')
  const str = (v: unknown, f: string) => (typeof v === 'string' ? v : f)

  return (
    <View pointerEvents="none" className={className}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="grid" width="38" height="38" patternUnits="userSpaceOnUse">
            <Line x1="0" y1="0" x2="38" y2="0" stroke={str(line, '#0002')} strokeWidth="1" />
            <Line x1="0" y1="0" x2="0" y2="38" stroke={str(line, '#0002')} strokeWidth="1" />
          </Pattern>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={str(panel, '#fff')} stopOpacity="0" />
            <Stop offset="0.55" stopColor={str(panel, '#fff')} stopOpacity="0.55" />
            <Stop offset="1" stopColor={str(panel, '#fff')} stopOpacity="1" />
          </LinearGradient>
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={str(accent, '#4630db')} stopOpacity="0.18" />
            <Stop offset="1" stopColor={str(accent, '#4630db')} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#grid)" opacity="0.7" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#fade)" />
        <Rect x="-200" y="-300" width="680" height="680" fill="url(#glow)" />
      </Svg>
    </View>
  )
}
