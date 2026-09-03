import { Link, Stack } from 'expo-router'
import { CompassIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'

import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'

/**
 * 兜底屏 —— deep link 指到一个不存在的路由时落这儿。
 *
 * ⚠️ 这个文件原来是 Expo 脚手架的原样：`'Oops!'` / `"This screen doesn't
 * exist."`，**没过 i18n、也没有一条样式**。它不在任何日常路径上，所以
 * 谁也不会注意到 —— 但它恰好是最可能被外部链接命中的一屏。
 */
export default function NotFoundScreen() {
  const { t } = useTranslation()
  return (
    <>
      <Stack.Screen options={{ title: t('页面不存在') }} />
      <View className="bg-background flex-1 items-center justify-center gap-3 px-10">
        <Icon as={CompassIcon} className="text-muted-foreground size-9" />
        <Text className="text-center font-medium">{t('这个页面不存在')}</Text>
        <Text variant="small" className="text-muted-foreground text-center leading-5">
          {t('链接可能已经失效，或者这一版还没有这个页面。')}
        </Text>
        <Link href="/" asChild>
          <Button variant="outline" size="sm" className="mt-1">
            <Text>{t('回到首页')}</Text>
          </Button>
        </Link>
      </View>
    </>
  )
}
