import { useRouter } from 'expo-router'
import { ChevronRightIcon, FileCheckIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import { Chevron, Group, GroupHeader, PressRow } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { Tile } from '@/components/workflow'
import { useDrafts, useStartable, type Definition } from '@/lib/workflow'

/**
 * 发起审批 · 选流程（#224 2b）。按分类分组，分类内按 `sort`。存着草稿的流程标「草稿」——
 * 点进去接着填（草稿是服务端存的，网页端填了一半，手机上能接着填）。
 */
export default function StartListScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const q = useStartable()
  const drafts = useDrafts()
  const [refreshing, setRefreshing] = React.useState(false)

  const groups = React.useMemo(() => {
    const map = new Map<string, Definition[]>()
    for (const d of [...(q.data ?? [])].sort((a, b) => a.sort - b.sort)) {
      const k = d.category || ''
      map.set(k, [...(map.get(k) ?? []), d])
    }
    // 没分类的排最后
    return [...map].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0))
  }, [q.data])
  // 草稿列表拉失败不挡路：只是少了「草稿」两个字，进去照样会读草稿
  const hasDraft = new Set((drafts.data ?? []).map((d) => d.code))

  async function onRefresh() {
    setRefreshing(true)
    try {
      await Promise.all([q.refetch(), drafts.refetch()])
    } finally {
      setRefreshing(false)
    }
  }

  if (q.error && !q.data) {
    return (
      <View className="bg-background flex-1 p-4">
        <Alert variant="destructive" icon={TriangleAlertIcon}>
          <AlertTitle>{t('流程列表拉取失败')}</AlertTitle>
          <AlertDescription>{q.error.message}</AlertDescription>
          <Button variant="outline" size="sm" onPress={() => void q.refetch()} className="mt-2 self-start">
            <Text>{t('重试')}</Text>
          </Button>
        </Alert>
      </View>
    )
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="pb-10"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      {!q.data ? (
        <View className="gap-2.5 px-4 pt-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[60px] rounded-xl" />
          ))}
        </View>
      ) : groups.length === 0 ? (
        <View className="items-center gap-2 py-20">
          <Icon as={FileCheckIcon} className="text-muted-foreground size-8" />
          <Text className="text-muted-foreground text-sm">{t('没有你能发起的流程')}</Text>
        </View>
      ) : (
        groups.map(([cat, defs]) => (
          <React.Fragment key={cat || '-'}>
            <GroupHeader>{cat || t('其他')}</GroupHeader>
            <Group>
              {defs.map((d, i) => (
                <PressRow
                  key={d.code}
                  first={i === 0}
                  inset={68}
                  onPress={() => router.push({ pathname: '/workflow/start/[code]', params: { code: d.code } })}
                  testID={`wf-start-${d.code}`}
                >
                  <Tile name={d.name} />
                  <View className="flex-1 gap-0.5">
                    <Text className="text-[15px]">{d.name}</Text>
                    {d.description ? (
                      <Text className="text-muted-foreground text-xs" numberOfLines={1}>
                        {d.description}
                      </Text>
                    ) : null}
                  </View>
                  {hasDraft.has(d.code) ? (
                    <View className="rounded-full bg-amber-500/15 px-2 py-0.5">
                      <Text className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{t('草稿')}</Text>
                    </View>
                  ) : null}
                  <Chevron icon={ChevronRightIcon} />
                </PressRow>
              ))}
            </Group>
          </React.Fragment>
        ))
      )}
    </ScrollView>
  )
}
