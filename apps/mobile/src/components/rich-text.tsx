import { ImageOffIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Image, Linking, Text as RNText, type TextStyle, View } from 'react-native'

import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { type Block, type Inline, parseRichText, resolveImageSrc, safeLinkHref } from '@/lib/rich-text'
import { useServer } from '@/lib/server'
import { cn } from '@/lib/utils'

/**
 * 富文本正文的**只读**渲染：`lib/rich-text.ts` 把 HTML 摊成块，这里一块一块画成原生组件。
 * 为什么不用 WebView / 第三方库、安全怎么保证，见那个文件的头注释。
 *
 * ⚠️ 只验过类型和打包（`expo export`），**没在设备上看过**：标题字号、列表缩进、
 * 引用的竖线这些都是照 iOS 分组列表的排版尺度定的，真机上可能要微调。
 */
export function RichText({ html, testID }: { html: string; testID?: string }) {
  const { t } = useTranslation()
  const blocks = React.useMemo(() => parseRichText(html), [html])
  const { base } = useServer()

  if (!blocks.length) {
    return <Text className="text-muted-foreground text-[14px]">{t('暂无内容')}</Text>
  }
  return (
    <View className="gap-3" testID={testID}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} base={base} />
      ))}
    </View>
  )
}

const ALIGN: Record<string, TextStyle['textAlign']> = { center: 'center', right: 'right', justify: 'justify' }

function BlockView({ block, base, muted }: { block: Block; base: string; muted?: boolean }) {
  const tone = muted ? 'text-muted-foreground' : undefined
  switch (block.kind) {
    case 'paragraph':
      return (
        // `selectable`：公告里常有要抄走的东西（电话、地址、会议号）
        <Text
          selectable
          className={cn('text-[15px] leading-6', tone)}
          style={block.align ? { textAlign: ALIGN[block.align] } : undefined}
        >
          <Runs runs={block.runs} />
        </Text>
      )
    case 'heading':
      return (
        <Text
          selectable
          role="heading"
          className={cn(
            block.level === 1 ? 'text-xl font-bold leading-7' : block.level === 2 ? 'text-lg font-semibold leading-7' : 'text-base font-semibold leading-6',
            tone,
          )}
          style={block.align ? { textAlign: ALIGN[block.align] } : undefined}
        >
          <Runs runs={block.runs} />
        </Text>
      )
    case 'list':
      return (
        <View className="gap-1.5">
          {block.items.map((item, i) => (
            <View key={i} className="flex-row gap-2">
              {/* 序号 / 圆点和正文同一行高，才和第一行文字对齐 */}
              <Text className={cn('text-muted-foreground min-w-4 text-[15px] leading-6', block.ordered && 'font-mono text-[13px]')}>
                {block.ordered ? `${block.start + i}.` : '•'}
              </Text>
              <View className="flex-1 gap-1.5">
                {item.map((b, j) => (
                  <BlockView key={j} block={b} base={base} muted={muted} />
                ))}
              </View>
            </View>
          ))}
        </View>
      )
    case 'quote':
      return (
        <View className="border-border gap-2 border-l-[3px] pl-3">
          {block.children.map((b, i) => (
            <BlockView key={i} block={b} base={base} muted />
          ))}
        </View>
      )
    case 'code':
      return (
        <View className="bg-muted rounded-lg px-3 py-2.5">
          <Text selectable className="font-mono text-[12px] leading-5">
            {block.text}
          </Text>
        </View>
      )
    case 'rule':
      return <View className="bg-border my-1 h-px" />
    case 'image':
      return <RichImage block={block} base={base} />
  }
}

/**
 * 行内片段。**嵌套的是 RN 原生 `Text`**，不是 `@/components/ui/text` ——
 * 后者自带 `text-foreground text-base`，套进段落里会把段落的字号 / 颜色顶掉。
 * 原生 `Text` 嵌套时继承外层的字号和颜色，只叠这里加的那一点样式。
 */
function Runs({ runs }: { runs: Inline[] }) {
  const { t } = useTranslation()
  return runs.map((r, i) => {
    const href = safeLinkHref(r.href)
    const lines = [r.underline || href ? 'underline' : null, r.strike ? 'line-through' : null].filter(Boolean).join(' ')
    return (
      <RNText
        key={i}
        className={cn(
          r.bold && 'font-semibold',
          r.italic && 'italic',
          r.code && 'bg-muted font-mono text-[13px]',
          // 链接要看得出能点 —— iOS 自己的「备忘录」「邮件」也是 tint 色 + 下划线
          href && 'text-primary',
        )}
        style={lines ? { textDecorationLine: lines as TextStyle['textDecorationLine'] } : undefined}
        onPress={
          href
            ? () => {
                Linking.openURL(href).catch(() => toast.error(t('打不开这个链接'), { description: href }))
              }
            : undefined
        }
      >
        {r.text}
      </RNText>
    )
  })
}

/**
 * 正文里的图片。
 *
 * 地址是公开子树的相对路径（不鉴权），拼上当前服务器地址就能读 —— 拼的是**运行时**的
 * `serverStore`，不是编译期常量（设置里能改服务器地址）。
 *
 * ⚠️ RN 的 `Image` 不会按图片本身的比例撑开高度：没有尺寸就是 0 高、整张图隐形。
 * 先用编辑器写进去的 `width` / `height` 属性（拖过角才有）或 16:9 占位，
 * `onLoad` 拿到真实尺寸再改比例。
 *
 * 加载失败 / 不是本服务器的图：留一块看得见的占位（硬纪律 9 —— 不能让图静默消失，
 * 读者会以为正文本来就这么短）。
 */
function RichImage({ block, base }: { block: Extract<Block, { kind: 'image' }>; base: string }) {
  const { t } = useTranslation()
  const uri = resolveImageSrc(block.src, base)
  const [ratio, setRatio] = React.useState<number | null>(
    block.width && block.height ? block.width / block.height : null,
  )
  const [failed, setFailed] = React.useState(false)

  if (!uri || failed) {
    return (
      <View className="bg-muted flex-row items-center gap-2 rounded-lg px-3 py-3">
        <Icon as={ImageOffIcon} className="text-muted-foreground size-4" />
        <Text className="text-muted-foreground flex-1 text-[13px]" numberOfLines={1}>
          {block.alt || t('图片无法显示')}
        </Text>
      </View>
    )
  }
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={block.alt || undefined}
      resizeMode="contain"
      onLoad={(e) => {
        const { width, height } = e.nativeEvent.source
        if (width > 0 && height > 0) setRatio(width / height)
      }}
      onError={() => setFailed(true)}
      className="bg-muted rounded-lg"
      style={{ width: '100%', maxWidth: block.width, aspectRatio: ratio ?? 16 / 9 }}
    />
  )
}
