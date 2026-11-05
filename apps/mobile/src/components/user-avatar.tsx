import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Text } from '@/components/ui/text'

/**
 * 用户头像：有图出图，没图出首字。全 App 只有这一份 —— 原来四个屏各写一遍，
 * 尺寸和圆角各不相同。
 *
 * 形状是圆角方块（squircle），圆角 ≈ 边长的 0.3，跟 iOS 应用图标的比例走。
 *
 * 🔴 **首字底色是主色的浅底 + 主色字，不是实心主色块。** 实心那版一屏十个
 * 一模一样的靛蓝方块，是全屏最重的东西，压过了名字本身；浅底保留「品牌陈述」
 * （分册「主色只能出现在这几处」里头像底那一条），但退到名字后面。
 *
 * ⚠️ 头像地址坏掉时 `AvatarImage` 静默不显示，`AvatarFallback` 兜住 —— 所以两个都要挂。
 */
export function UserAvatar({ name, src, size = 44 }: { name: string; src?: string | null; size?: number }) {
  const radius = Math.round(size * 0.3)
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase()
  return (
    <Avatar alt={name} style={{ width: size, height: size, borderRadius: radius }}>
      {src ? <AvatarImage source={{ uri: src }} /> : null}
      <AvatarFallback className="bg-primary/10" style={{ borderRadius: radius }}>
        <Text className="text-primary font-semibold" style={{ fontSize: Math.round(size * 0.4) }}>
          {initial}
        </Text>
      </AvatarFallback>
    </Avatar>
  )
}
