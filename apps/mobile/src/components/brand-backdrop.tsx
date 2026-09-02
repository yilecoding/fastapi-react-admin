import { View } from 'react-native'
import Svg, { Defs, LinearGradient, Line, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg'
import { useCSSVariable } from 'uniwind'

/**
 * 品牌纹理：38px 方格 + 左上角一团主色辉光。
 *
 * 🔴 **只能铺在一张有边界的卡的内部**（父级 `overflow-hidden` + 圆角），
 * 不能全屏铺。实测过全屏：那团辉光在手机上就是一块脏污，方格则读作噪点 ——
 * web 上它好看是因为被限制在一张有边、有圆角的面板里，三者互相定义。
 *
 * 🔴 渐隐用**竖向线性**，不要照抄 web 的 `radial-gradient` mask ——
 * 在手机的窄长比例下那个圆的边界会压出一条清晰的横带。
 *
 * ⚠️ web 那边还有第三层胶片颗粒（`feTurbulence`）。`react-native-svg` 的
 * filter 支持不全，没做 —— 缺了它会平一点，但不会错。
 */
export function BrandBackdrop() {
  const accent = useCSSVariable('--color-accent')
  const line = useCSSVariable('--color-line')
  const node = useCSSVariable('--color-node')
  const str = (v: unknown, f: string) => (typeof v === 'string' ? v : f)

  return (
    <View pointerEvents="none" className="absolute inset-0">
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="grid" width="38" height="38" patternUnits="userSpaceOnUse">
            <Line x1="0" y1="0" x2="38" y2="0" stroke={str(line, '#0002')} strokeWidth="1" />
            <Line x1="0" y1="0" x2="0" y2="38" stroke={str(line, '#0002')} strokeWidth="1" />
          </Pattern>
          <LinearGradient id="fade" x1="0" y1="0" x2="0.5" y2="1">
            <Stop offset="0.15" stopColor={str(node, '#fff')} stopOpacity="0" />
            <Stop offset="1" stopColor={str(node, '#fff')} stopOpacity="0.9" />
          </LinearGradient>
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={str(accent, '#4630db')} stopOpacity="0.13" />
            <Stop offset="1" stopColor={str(accent, '#4630db')} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#grid)" opacity="0.6" />
        <Rect x="-120" y="-190" width="420" height="420" fill="url(#glow)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#fade)" />
      </Svg>
    </View>
  )
}
