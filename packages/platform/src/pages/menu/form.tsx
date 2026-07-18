import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { IconAlertTriangle, IconLoader2 } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Label } from '@admin/ui/components/label'
import { Combobox } from '@admin/ui/components/combobox'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@admin/ui/components/sheet'
import { Switch } from '@admin/ui/components/switch'

import { ApiError } from '../../api-client/errors'
import { usePlatform } from '../../shell/platform-context'
import { useFieldError } from '../_shared/form-error'
import { FormField, FormSection } from '../_shared/form-fields'
import {
  MENU_TYPE, MENU_TYPE_ITEMS, parentMenuOptions,
  useCreateMenu, useUpdateMenu, type Menu,
} from './api'
import { hasVisibleChild } from './dead-link'
import { IconPicker } from './icon-picker'

const ROOT = '__root__'

const schema = z
  .object({
    title: z.string().min(1, '请输入菜单标题').max(64),
    name: z.string().min(1, '请输入菜单名称').max(64)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/, '名称须为英文，字母开头（作路由 name 用）'),
    type: z.coerce.number().int(),
    parent_id: z.string().optional(),
    path: z.string().optional(),
    perms: z.string().optional(),
    link: z.string().optional(),
    icon: z.string().optional(),
    sort: z.coerce.number().int().min(0),
    status: z.coerce.number().int(),
    display: z.coerce.number().int(),
    remark: z.string().max(200).optional(),
  })
  // 不同类型必填项不同 —— 这是这个表单最容易出错的地方，用 superRefine 集中表达
  .superRefine((v, ctx) => {
    if (v.type === MENU_TYPE.BUTTON) {
      if (!v.perms?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['perms'], message: '按钮必须填写权限标识' })
      }
      return
    }
    if (v.type === MENU_TYPE.LINK || v.type === MENU_TYPE.IFRAME) {
      if (!v.link?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['link'], message: '外链/内嵌必须填写地址' })
      }
    }
    if (!v.path?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: '请选择路由地址' })
    }
  })
type Values = z.infer<typeof schema>

export function MenuFormSheet({
  open, onOpenChange, editing, presetParentId, tree,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: Menu | null
  presetParentId?: string | null
  tree: Menu[]
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateMenu()
  const update = useUpdateMenu()
  const [err, setErr] = React.useState<string | null>(null)
  const { validPaths } = usePlatform()

  const parents = React.useMemo(() => parentMenuOptions(tree, editing?.id), [tree, editing])
  const parentOptions = React.useMemo(
    () => [
      { value: ROOT, label: t('顶级菜单') },
      ...parents.map((p) => ({ value: p.id, label: p.label.trim() })),
    ],
    [parents, t]
  )

  // 模块级常量的中文是 key，在**渲染处**翻 —— Base UI 的 Select 关闭态靠 items 显示标签
  const typeItems = React.useMemo(
    () => Object.fromEntries(Object.entries(MENU_TYPE_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )
  const statusItems = React.useMemo(() => ({ '1': t('正常'), '0': t('停用') }), [t])

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      title: '', name: '', type: MENU_TYPE.MENU, parent_id: ROOT, path: '', perms: '',
      link: '', icon: '', sort: 0, status: 1, display: 1, remark: '',
    },
  })

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    form.reset(editing
      ? {
          title: editing.title, name: editing.name, type: editing.type,
          parent_id: editing.parent_id ?? ROOT, path: editing.path ?? '',
          perms: editing.perms ?? '', link: editing.link ?? '', icon: editing.icon ?? '',
          sort: editing.sort, status: editing.status, display: editing.display,
          remark: editing.remark ?? '',
        }
      : {
          title: '', name: '', type: MENU_TYPE.MENU, parent_id: presetParentId ?? ROOT,
          path: '', perms: '', link: '', icon: '', sort: 0, status: 1, display: 1, remark: '',
        })
  }, [open, editing, presetParentId, form])

  const type = form.watch('type')
  const isButton = type === MENU_TYPE.BUTTON
  const isExternal = type === MENU_TYPE.LINK || type === MENU_TYPE.IFRAME
  const path = form.watch('path') ?? ''
  const pathOptions = React.useMemo(
    () => validPaths.map((p) => ({ value: p, label: p })),
    [validPaths]
  )
  // 编辑历史数据时，它的 path 可能已不在前端路由里 —— 要显式告警而不是静默丢失
  const pathMissing = Boolean(path) && !validPaths.includes(path)

  /**
   * 目录有可见子项时，它的 `path` **根本不会被侧边栏用到**
   * （`toNavTree` 直接把它当可展开分组，见 `dead-link.ts`）。
   * 这种情况下 path 无效不是问题，不该报「侧边栏会跳过它」——
   * 那句话是假的，侧边栏一直正常显示它。
   */
  const dirPathUnused =
    type === MENU_TYPE.DIR && editing !== null && hasVisibleChild(editing, (p) => validPaths.includes(p))

  const pending = create.isPending || update.isPending
  const errs = form.formState.errors

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑菜单') : t('新增菜单')}</SheetTitle>
          <SheetDescription>
            {t('路由地址从前端真实存在的路由里选，填不错。按钮类不进侧边栏，只提供权限标识。')}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={form.handleSubmit(async (v) => {
            setErr(null)
            const body = {
              title: v.title.trim(),
              name: v.name.trim(),
              type: v.type,
              parent_id: v.parent_id === ROOT ? null : v.parent_id || null,
              path: isButton ? null : v.path?.trim() || null,
              perms: v.perms?.trim() || null,
              link: isExternal ? v.link?.trim() || null : null,
              icon: v.icon?.trim() || null,
              sort: v.sort,
              status: v.status,
              display: isButton ? 0 : v.display,
              remark: v.remark?.trim() || null,
            }
            try {
              if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
              else await create.mutateAsync(body)
              onOpenChange(false)
            } catch (e) { setErr(e instanceof ApiError ? e.message : t('保存失败')) }
          })}
          className="flex flex-1 flex-col overflow-hidden"
        >
          {/*
            overflow-x-hidden 不是多余的：CSS 规定一个轴是 visible、另一个轴不是时，
            visible 会**计算成 auto**。所以光写 `overflow-y-auto`，
            横向溢出会自动长出一条滚动条 —— 实测这个 div 的 computed overflowX 就是 auto。
            后果是任何一个不肯收缩的子元素都会把整列标签推出可视区，
            而且现象离原因很远（谁会想到图标行的 w-full 会让「菜单类型」变成「单类型」）。
            钉成 hidden：将来再有溢出是「右边被裁掉」，一眼能看出来。
          */}
          {/* gap-6 而组内 gap-4：分组间距必须大于组内间距，
              两者都 16px 的话分节头就只是一行字，读不出层级 */}
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden px-4 py-2">
            <FormSection title={t("基本信息")}>
            <FormField label={t("菜单类型")} required>
              <Select value={String(type)} items={typeItems}
                      onValueChange={(v) => form.setValue('type', Number(v), { shouldValidate: true })}>
                <SelectTrigger className="w-full" data-testid="m-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(MENU_TYPE_ITEMS).map(([v, l]) => <SelectItem key={v} value={v}>{t(l)}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t("菜单标题")} error={fe(errs.title?.message)} required>
                <Input {...form.register('title')} data-testid="m-title" autoComplete="off" />
              </FormField>
              <FormField label={t("菜单名称")} error={fe(errs.name?.message)} required>
                <Input {...form.register('name')} data-testid="m-name" autoComplete="off"
                       placeholder={t("英文，如 OrderList")} />
              </FormField>
            </div>

            {/* 菜单可以有几十上百个 —— 用 Combobox 而不是 Select，否则只能瞎滚 */}
            <FormField label={t("上级菜单")}>
              <Combobox
                value={form.watch('parent_id') || ROOT}
                onValueChange={(v) => form.setValue('parent_id', v ?? undefined, { shouldValidate: true })}
                options={parentOptions}
                searchPlaceholder={t('搜索菜单')}
                emptyText={t('没有匹配的菜单')}
                data-testid="m-parent"
              />
            </FormField>
            </FormSection>

            <FormSection title={t("路由与权限")}>
            {/* 按钮没有路由；其余类型的 path 从前端真实路由里选 */}
            {!isButton && (
              <FormField label={t("路由地址")} error={fe(errs.path?.message)} required>
                <Combobox
                  value={path}
                  onValueChange={(v) => form.setValue('path', v ?? undefined, { shouldValidate: true })}
                  options={pathOptions}
                  placeholder={t("从前端已有路由中选择")}
                  searchPlaceholder={t('搜索路由')}
                  emptyText={t('没有匹配的路由')}
                  data-testid="m-path"
                  renderItem={(o) => <code className="truncate text-xs">{o.label}</code>}
                />
                {pathMissing && dirPathUnused && (
                  <p className="text-[11px] text-muted-foreground" data-testid="m-path-unused">
                    <Trans
                      t={t}
                      i18nKey="这个目录有子项，侧边栏会把它当可展开分组 —— 地址不会被用到，填的 <c>{{path}}</c> 在前端不存在也没关系。"
                      values={{ path }}
                      components={{ c: <code /> }}
                    />
                  </p>
                )}
                {pathMissing && !dirPathUnused && (
                  <p
                    className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300"
                    data-testid="m-path-missing"
                  >
                    <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <Trans
                        t={t}
                        i18nKey="当前值 <c>{{path}}</c> 在前端路由里不存在，侧边栏会跳过它。重新选一个，或到 <d>apps/web/src/routes</d> 下补这个页面。"
                        values={{ path }}
                        components={{ c: <code />, d: <code /> }}
                      />
                    </span>
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {t('只列出前端真实存在的 {{n}} 个路由 —— 从根上杜绝死链。', { n: validPaths.length })}
                </p>
              </FormField>
            )}

            {isExternal && (
              <FormField label={type === MENU_TYPE.LINK ? t('外链地址') : t('内嵌地址')} error={fe(errs.link?.message)} required>
                <Input {...form.register('link')} data-testid="m-link" placeholder="https://…" />
              </FormField>
            )}

            <FormField
              label={t("权限标识")}
              error={fe(errs.perms?.message)}
              required={isButton}
            >
              <Input {...form.register('perms')} data-testid="m-perms" autoComplete="off"
                     placeholder={t("如 order:record:add")} />
              <p className="text-[11px] text-muted-foreground">
                <Trans
                  t={t}
                  i18nKey="前端 <c>&lt;Can&gt;</c> 与后端 <d>rbac_verify</d> 都读这个值。"
                  components={{ c: <code />, d: <code /> }}
                />
              </p>
            </FormField>
            </FormSection>

            <FormSection title={t("显示与排序")}>
            {!isButton && (
              <FormField label={t("图标")}>
                <IconPicker
                  value={form.watch('icon') ?? ''}
                  onChange={(v) => form.setValue('icon', v ?? undefined, { shouldValidate: true })}
                  data-testid="m-icon"
                />
              </FormField>
            )}

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t("排序")} error={fe(errs.sort?.message)}>
                <Input type="number" min={0} {...form.register('sort')} data-testid="m-sort" />
              </FormField>
              <FormField label={t("状态")} required>
                <Select value={String(form.watch('status'))} items={statusItems}
                        onValueChange={(v) => form.setValue('status', Number(v), { shouldValidate: true })}>
                  <SelectTrigger className="w-full" data-testid="m-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t('正常')}</SelectItem>
                    <SelectItem value="0">{t('停用')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            {!isButton && (
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="m-display">{t('在侧边栏显示')}</Label>
                  <span className="text-xs text-muted-foreground">{t('关闭后仍可通过地址访问，只是不出现在菜单里。')}</span>
                </div>
                <Switch id="m-display" data-testid="m-display"
                        checked={form.watch('display') === 1}
                        onCheckedChange={(c) => form.setValue('display', c ? 1 : 0)} />
              </div>
            )}

            <FormField label={t("备注")}>
              <Input {...form.register('remark')} data-testid="m-remark" autoComplete="off" />
            </FormField>
            </FormSection>

            {err && <p className="text-sm text-destructive" data-testid="form-error">{err}</p>}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="m-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t('保存修改') : t('创建菜单')}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

