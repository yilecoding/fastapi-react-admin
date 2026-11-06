import { ApiError, forecastItems, isEmpty, missingRequired, type TrackItem } from '@admin/api'
import { formatDateTime } from '@admin/i18n'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Chevron, Group, GroupHeader, PressRow } from '@/components/grouped'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Text } from '@/components/ui/text'
import { toast } from '@/components/ui/toast'
import { Tile, Track, UserPicker } from '@/components/workflow'
import { WorkflowForm } from '@/components/workflow-form'
import { useDebounced } from '@/lib/debounce'
import { useSession } from '@/lib/session'
import {
  idempotencyKey,
  invalidateDraftList,
  removeDraft,
  saveDraft,
  useDirectoryUsersByIds,
  useDraft,
  useInstance,
  usePreview,
  useStartForm,
  useStartInstance,
  type FieldPerm,
  type FormData,
  type StartForm,
} from '@/lib/workflow'

/**
 * 发起审批 · 填写（#224 2b）。口径照 web `start-sheet.tsx`，少了「AI 帮填」（那一块要传文件 / 图片给模型，
 * 先留在网页端）。
 *
 * - `?from=<实例 ID>`：**重新发起**（已驳回 / 撤回的单），内容从旧单复制；这时不读也不写这个流程的草稿 ——
 *   那是另一张没写完的单，存进去会把它覆盖、提交会把它删掉（同 web `fromOld`）
 * - 草稿存服务端（一人一流程一份）：边填边存，网页端填了一半手机上能接着填，提交成功服务端顺手删掉
 * - 下面的「审批流程」是服务端按**当前填的内容**试算的：天数改成 5，就多出一个上级主管
 */
export default function StartScreen() {
  const { t } = useTranslation()
  const { code, from } = useLocalSearchParams<{ code: string; from?: string }>()
  const fromId = from || null
  const sf = useStartForm(code)
  const old = useInstance(fromId ?? '', !!fromId)
  const draft = useDraft(code, !fromId)

  const loading = sf.isPending || (fromId ? old.isPending : draft.isPending)
  const error = sf.error ?? (fromId ? old.error : null)

  return (
    <View className="bg-background flex-1">
      {error ? (
        <View className="p-4">
          <Alert variant="destructive" icon={TriangleAlertIcon}>
            <AlertTitle>{t('表单拉取失败')}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void (sf.error ? sf.refetch() : old.refetch())}
              className="mt-2 self-start"
            >
              <Text>{t('重试')}</Text>
            </Button>
          </Alert>
        </View>
      ) : loading || !sf.data ? (
        <View className="gap-3 p-4">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </View>
      ) : (
        <Filler
          // 草稿 / 旧单都只在进屏时读一次；之后以手上正在填的为准
          key={`${code}:${fromId ?? ''}`}
          code={code}
          sf={sf.data}
          initial={fromId ? old.data?.form_data : draft.data?.form}
          initialFiles={fromId ? old.data?.files : undefined}
          restoredAt={fromId ? undefined : draft.data?.updated_time}
          draftError={!fromId && !!draft.error}
          fromOld={!!fromId}
        />
      )}
    </View>
  )
}

function Filler({
  code,
  sf,
  initial,
  initialFiles,
  restoredAt,
  draftError,
  fromOld,
}: {
  code: string
  sf: StartForm
  initial?: FormData
  initialFiles?: Record<string, { name: string }>
  restoredAt?: string
  draftError: boolean
  fromOld: boolean
}) {
  const { t } = useTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { user } = useSession()
  const start = useStartInstance()

  // 发起人的字段权限（开始节点上配的，没配 = 可填）：hidden 的根本不出现，readonly 的只显示
  const startPerms = React.useMemo(() => sf.model.root.fieldPerms ?? {}, [sf.model])
  const schema = React.useMemo(
    () => ({ ...sf.form, fields: sf.form.fields.filter((f) => startPerms[f.id] !== 'hidden') }),
    [sf.form, startPerms],
  )
  const perms = React.useMemo(
    () => Object.fromEntries(schema.fields.map((f) => [f.id, startPerms[f.id] ?? 'editable'])) as Record<string, FieldPerm>,
    [schema, startPerms],
  )
  const editable = React.useMemo(
    () => new Set(Object.entries(perms).filter(([, p]) => p === 'editable').map(([k]) => k)),
    [perms],
  )

  // 旧单 / 草稿的内容只取当前表单里还在、发起人能填的字段 —— 流程改过版本的话旧字段可能已经没了
  const [form, setForm] = React.useState<FormData>(() =>
    initial ? Object.fromEntries(Object.entries(initial).filter(([k]) => editable.has(k))) : {},
  )
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [urgent, setUrgent] = React.useState(false)
  const [restored, setRestored] = React.useState(!!restoredAt && !!initial && Object.keys(initial).length > 0)
  const [picking, setPicking] = React.useState<{ id: string; name: string } | null>(null)
  const draft = useDraftAutosave(code, form, !fromOld)
  // 一次填写 = 一个幂等键：网络抖动重试 / 双击提交不会建出两张单
  const [key] = React.useState(idempotencyKey)

  const inputs = React.useMemo(() => ({ form, selected }), [form, selected])
  const debounced = useDebounced(inputs, 400)
  const preview = usePreview(code, debounced.form, debounced.selected)

  // 自选审批人只问**会走到**的那几个节点（服务端也只校验这些）。试算还没回来时先全列出来
  const pickNodes = React.useMemo(() => {
    const steps = preview.data?.steps
    if (!steps) return sf.select_nodes
    const onPath = new Set(steps.map((s) => s.node_id))
    return sf.select_nodes.filter((n) => onPath.has(n.id))
  }, [preview.data, sf.select_nodes])
  const pickedIds = Object.values(selected).flat()
  const pickedUsers = useDirectoryUsersByIds(pickedIds)
  const nameOf = (id: string) => pickedUsers.data?.find((u) => u.id === id)?.nickname ?? '…'

  const track: TrackItem[] = [
    { key: 'start', kind: 'start', title: t('发起申请'), state: 'done', people: [{ name: user?.nickname ?? '' }] },
    ...forecastItems(preview.data?.steps ?? [], t, 'starter'),
    { key: 'end', kind: 'end', title: t('结束'), state: 'future' },
  ]

  function changeForm(next: FormData) {
    setForm(next)
    // 改过的字段的报错当场去掉，别让人改完了还盯着一行红字
    setErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([k]) => next[k] === form[k])))
  }

  async function submit() {
    const errs: Record<string, string> = {}
    for (const [k, label] of Object.entries(missingRequired(schema, form, editable))) {
      errs[k] = t('请填写「{{f}}」', { f: label })
    }
    for (const n of pickNodes) if (!selected[n.id]?.length) errs[`select:${n.id}`] = t('请选择审批人')
    setErrors(errs)
    if (Object.keys(errs).length) {
      toast.error(t('还有 {{n}} 项没填', { n: Object.keys(errs).length }))
      return
    }
    // 提交之前：停掉自动保存，并**等正在路上的那次保存落地** —— 否则它可能在服务端删完草稿之后才到，
    // 把草稿又存回来，下次打开「已恢复你没提交的内容」，而那张单其实已经交了（同 web）
    await draft.stop()
    try {
      // 走不到的节点上选过的人不带过去
      const picked = Object.fromEntries(pickNodes.filter((n) => selected[n.id]).map((n) => [n.id, selected[n.id]]))
      const res = await start.mutateAsync({ code, form, selected: picked, key, urgent, keep_draft: fromOld })
      toast.success(t('已提交'))
      router.replace({ pathname: '/workflow/[id]', params: { id: String(res.instance_id) } })
    } catch (e) {
      // 后端的字段级错误（`detail` 是 字段 ID → 原因）直接挂到字段下面
      if (e instanceof ApiError && e.detail && typeof e.detail === 'object') {
        setErrors(e.detail as Record<string, string>)
      }
      toast.error(e instanceof Error ? e.message : t('提交失败，请稍后重试'))
      draft.resume()
    }
  }

  async function clearDraft() {
    // 同提交：先等路上那次保存落地再删，不然它可能在删之后才到、把草稿又存回来
    await draft.stop()
    try {
      await removeDraft(code)
      setForm({})
      setErrors({})
      setRestored(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('操作失败，请稍后重试'))
    } finally {
      draft.resume()
    }
  }

  return (
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerClassName="pb-6" keyboardShouldPersistTaps="handled">
        <View className="flex-row items-center gap-3 px-4 pt-4">
          <Tile name={sf.definition.name} large />
          <View className="flex-1 gap-0.5">
            <Text className="text-lg font-semibold">{sf.definition.name}</Text>
            <Text className="text-muted-foreground text-xs" numberOfLines={2}>
              {sf.definition.description || t('填写后提交，审批流程见下方')}
            </Text>
          </View>
        </View>

        {fromOld ? (
          <Banner testID="wf-from-old">{t('内容复制自原来那张单，改好再提交。')}</Banner>
        ) : restored && restoredAt ? (
          <Banner testID="wf-draft-restored">
            {t('已恢复你 {{at}} 没提交的内容', { at: formatDateTime(restoredAt) })}
            {'  '}
            <Text className="text-primary text-xs" onPress={() => void clearDraft()} testID="wf-draft-clear">
              {t('清空重填')}
            </Text>
          </Banner>
        ) : draftError ? (
          <Banner tone="warn">{t('上次的草稿没读出来，可以照常填写')}</Banner>
        ) : null}

        <GroupHeader>{t('申请内容')}</GroupHeader>
        <WorkflowForm schema={schema} value={form} onChange={changeForm} perms={perms} errors={errors} files={initialFiles} />

        {pickNodes.length > 0 ? (
          <>
            <GroupHeader>{t('选择审批人')}</GroupHeader>
            <Group>
              {pickNodes.map((n, i) => {
                const ids = selected[n.id] ?? []
                const err = errors[`select:${n.id}`]
                return (
                  <PressRow key={n.id} first={i === 0} onPress={() => setPicking(n)} testID={`wf-select-${n.id}`}>
                    <View className="flex-1 gap-0.5">
                      <Text className="text-[15px]">{n.name}</Text>
                      {err && !ids.length ? <Text className="text-destructive text-xs">{err}</Text> : null}
                    </View>
                    <Text className={`max-w-[55%] text-[13px] ${ids.length ? '' : 'text-muted-foreground'}`} numberOfLines={1}>
                      {ids.length ? ids.map(nameOf).join('、') : t('去选择')}
                    </Text>
                    <Chevron icon={ChevronRightIcon} />
                  </PressRow>
                )
              })}
            </Group>
          </>
        ) : null}

        <View className="flex-row items-end justify-between pr-8">
          <GroupHeader>{t('审批流程')}</GroupHeader>
          {preview.isFetching ? <ActivityIndicator size="small" className="pb-1.5" /> : null}
        </View>
        {preview.error && !preview.data ? (
          <View className="px-4">
            <Alert variant="destructive" icon={TriangleAlertIcon}>
              <AlertTitle>{t('流程试算失败')}</AlertTitle>
              <AlertDescription>{preview.error.message}</AlertDescription>
              <Button variant="outline" size="sm" onPress={() => void preview.refetch()} className="mt-2 self-start">
                <Text>{t('重试')}</Text>
              </Button>
            </Alert>
          </View>
        ) : !preview.data ? (
          <View className="px-4">
            <Skeleton className="h-32 rounded-2xl" />
          </View>
        ) : (
          <Track items={track} />
        )}
        <Text className="text-muted-foreground px-8 pt-2 text-xs">{t('按你当前填写的内容推算，改了条件相关的字段会跟着变')}</Text>
      </ScrollView>

      <View
        className="bg-card border-border gap-2 border-t px-4 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <View className="flex-row items-center gap-2">
          <Pressable className="flex-row items-center gap-2" onPress={() => setUrgent((u) => !u)} testID="wf-start-urgent">
            <Checkbox checked={urgent} onCheckedChange={(v) => setUrgent(!!v)} />
            <Text className="text-[14px]">{t('加急')}</Text>
          </Pressable>
          <Text className="text-muted-foreground ml-auto text-xs" testID="wf-draft-status">
            {fromOld
              ? ''
              : draft.status === 'saving'
                ? t('草稿保存中…')
                : draft.status === 'error'
                  ? t('草稿没存上，再改一下会重试')
                  : draft.savedAt
                    ? t('草稿已保存')
                    : ''}
          </Text>
        </View>
        <Button onPress={() => void submit()} disabled={start.isPending} testID="wf-start-submit">
          {start.isPending ? <ActivityIndicator size="small" color="white" /> : null}
          <Text>{t('提交')}</Text>
        </Button>
      </View>

      {picking ? (
        <UserPicker
          open
          multiple
          initial={selected[picking.id] ?? []}
          title={t('{{node}}：选择审批人', { node: picking.name })}
          onClose={() => setPicking(null)}
          onDone={(us) => {
            setSelected((s) => ({ ...s, [picking.id]: us.map((u) => u.id) }))
            setErrors(({ [`select:${picking.id}`]: _, ...rest }) => rest)
            setPicking(null)
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  )
}

function Banner({
  children,
  tone,
  testID,
}: {
  children: React.ReactNode
  tone?: 'warn'
  testID?: string
}) {
  return (
    <View
      className={`mx-4 mt-4 rounded-xl px-3 py-2 ${tone === 'warn' ? 'bg-amber-500/15' : 'bg-muted'}`}
      testID={testID}
    >
      <Text className={`text-xs leading-5 ${tone === 'warn' ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'}`}>
        {children}
      </Text>
    </View>
  )
}

/**
 * 边填边存草稿：停手 1.5 秒存一次，内容没变不存（同 web `useDraftAutosave`）。
 *
 * `stop()` / `resume()`：提交那一刻先停 —— 防抖里排着的那次保存要是在提交成功之后才发出去，
 * 服务端刚删掉的草稿又被存回来。`stop()` 还要**等正在路上的那次落地**：已经发出去的 PUT 拦不住
 */
function useDraftAutosave(code: string, form: FormData, enabled: boolean) {
  const qc = useQueryClient()
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'error'>('idle')
  const [savedAt, setSavedAt] = React.useState<string | null>(null)
  const stoppedRef = React.useRef(false)
  const inflightRef = React.useRef<Promise<unknown> | null>(null)
  const lastRef = React.useRef(JSON.stringify(form))
  React.useEffect(() => {
    if (!enabled) return
    const raw = JSON.stringify(form)
    if (raw === lastRef.current) return
    const h = setTimeout(async () => {
      if (stoppedRef.current) return
      setStatus('saving')
      let done: () => void = () => {}
      inflightRef.current = new Promise<void>((r) => {
        done = r
      })
      try {
        // 全清空了：删草稿而不是存一份空的（否则下次打开是「已恢复你没提交的内容」+ 一张白表）
        const blank = Object.values(form).every(isEmpty)
        await (blank ? removeDraft(code) : saveDraft(code, form))
        lastRef.current = raw
        void invalidateDraftList(qc)
        setSavedAt(new Date().toISOString())
        setStatus('idle')
      } catch {
        setStatus('error')
      } finally {
        done()
        inflightRef.current = null
      }
    }, 1500)
    return () => clearTimeout(h)
  }, [code, form, enabled, qc])
  return {
    status,
    savedAt,
    stop: async () => {
      stoppedRef.current = true
      await inflightRef.current
    },
    resume: () => {
      stoppedRef.current = false
    },
  }
}
