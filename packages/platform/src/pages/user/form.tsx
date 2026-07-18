import * as React from "react"
import { useTranslation } from "react-i18next"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { IconLoader2 } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Checkbox } from "@admin/ui/components/checkbox"
import { Input } from "@admin/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/ui/components/select"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/ui/components/sheet"

import { ApiError } from "../../api-client/errors"
import { useFieldError } from "../_shared/form-error"
import { FormField, FormSection } from "../_shared/form-fields"
import {
  allRolesQuery,
  deptTreeQuery,
  flattenDepts,
  useCreateUser,
  useUpdateUser,
  type User,
} from "./api"

/**
 * 表单 schema。
 *
 * 注意所有 ID 都是 string —— 雪花 ID 不能用 number 承载。
 */
const baseSchema = z.object({
  username: z.string().min(1, "请输入用户名").max(64),
  nickname: z.string().min(1, "请输入昵称").max(64),
  email: z.union([z.email("邮箱格式不正确"), z.literal("")]).optional(),
  phone: z
    .union([
      z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
      z.literal(""),
    ])
    .optional(),
  dept_id: z.string().min(1, "请选择部门"),
  roles: z.array(z.string()).min(1, "至少选择一个角色"),
})

const createSchema = baseSchema.extend({
  password: z.string().min(6, "密码至少 6 位").max(64),
})

type CreateValues = z.infer<typeof createSchema>
type EditValues = z.infer<typeof baseSchema>

export function UserFormSheet({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: User | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const { data: deptTree = [] } = useQuery(deptTreeQuery)
  const { data: roles = [] } = useQuery(allRolesQuery)
  const depts = React.useMemo(() => flattenDepts(deptTree), [deptTree])
  // 同上：关闭态要靠 items 才能显示部门名而不是雪花 ID
  const deptItems = React.useMemo(
    () => Object.fromEntries(depts.map((d) => [d.id, d.label.trim()])),
    [depts]
  )

  const create = useCreateUser()
  const update = useUpdateUser()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<CreateValues | EditValues>({
    resolver: zodResolver(isEdit ? baseSchema : createSchema) as never,
    defaultValues: {
      username: "",
      nickname: "",
      email: "",
      phone: "",
      dept_id: "",
      roles: [],
      password: "",
    } as CreateValues,
  })

  // 打开时用当前记录回填；关闭时不清空，避免关闭动画期间闪空
  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            username: editing.username,
            nickname: editing.nickname,
            email: editing.email ?? "",
            phone: editing.phone ?? "",
            dept_id: editing.dept_id ?? "",
            roles: editing.roles.map((r) => r.id),
          }
        : {
            username: "",
            nickname: "",
            email: "",
            phone: "",
            dept_id: "",
            roles: [],
            password: "",
          }
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending

  async function onSubmit(values: CreateValues | EditValues) {
    setServerError(null)
    const common = {
      username: values.username.trim(),
      nickname: values.nickname.trim(),
      email: values.email?.trim() || null,
      phone: values.phone?.trim() || null,
      roles: values.roles,
    }
    try {
      if (isEdit && editing) {
        await update.mutateAsync({
          id: editing.id,
          body: { ...common, dept_id: values.dept_id },
        })
      } else {
        await create.mutateAsync({
          ...common,
          dept_id: values.dept_id,
          password: (values as CreateValues).password,
        })
      }
      onOpenChange(false)
    } catch (e) {
      setServerError(
        e instanceof ApiError ? e.message : t("保存失败，请稍后重试")
      )
    }
  }

  const errs = form.formState.errors
  const selectedRoles = form.watch("roles") ?? []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? t("编辑用户") : t("新增用户")}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? t("修改用户资料与角色分配。")
              : t("填写下列信息创建新用户。")}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-1 flex-col overflow-hidden"
        >
          {/* 外层 gap-6 而组内 gap-4：分组间距必须大于组内间距，
              两者都 16px 的话分节头就只是一行字，读不出层级 */}
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-2">
            <FormSection title={t("账号信息")}>
              <FormField
                label={t("用户名")}
                error={fe(errs.username?.message)}
                required
              >
                <Input
                  {...form.register("username")}
                  data-testid="f-username"
                  disabled={isEdit}
                  autoComplete="off"
                />
              </FormField>

              <FormField
                label={t("昵称")}
                error={fe(errs.nickname?.message)}
                required
              >
                <Input
                  {...form.register("nickname")}
                  data-testid="f-nickname"
                  autoComplete="off"
                />
              </FormField>

              {!isEdit && (
                <FormField
                  label={t("密码")}
                  error={fe(
                    (errs as Record<string, { message?: string }>).password
                      ?.message
                  )}
                  required
                >
                  <Input
                    type="password"
                    {...form.register("password")}
                    data-testid="f-password"
                    autoComplete="new-password"
                  />
                </FormField>
              )}
            </FormSection>

            <FormSection title={t("联系信息")}>
              <div className="grid grid-cols-2 gap-4">
                <FormField label={t("邮箱")} error={fe(errs.email?.message)}>
                  <Input
                    {...form.register("email")}
                    data-testid="f-email"
                    autoComplete="off"
                  />
                </FormField>
                <FormField label={t("手机号")} error={fe(errs.phone?.message)}>
                  <Input
                    {...form.register("phone")}
                    data-testid="f-phone"
                    autoComplete="off"
                  />
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t("归属与权限")}>
              <FormField
                label={t("部门")}
                error={fe(errs.dept_id?.message)}
                required
              >
                <Select
                  value={form.watch("dept_id")}
                  items={deptItems}
                  onValueChange={(v) =>
                    form.setValue("dept_id", v ?? "", { shouldValidate: true })
                  }
                >
                  <SelectTrigger className="w-full" data-testid="f-dept">
                    <SelectValue placeholder={t("选择部门")} />
                  </SelectTrigger>
                  <SelectContent>
                    {depts.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label={t("角色")}
                error={fe(errs.roles?.message)}
                required
              >
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  {roles.length === 0 && (
                    <span className="text-sm text-muted-foreground">
                      {t("暂无可分配角色")}
                    </span>
                  )}
                  {roles.map((r) => {
                    const checked = selectedRoles.includes(r.id)
                    return (
                      <label
                        key={r.id}
                        className="flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={checked}
                          data-testid={`f-role-${r.name}`}
                          onCheckedChange={(c) => {
                            const next = c
                              ? [...selectedRoles, r.id]
                              : selectedRoles.filter((x) => x !== r.id)
                            form.setValue("roles", next, {
                              shouldValidate: true,
                            })
                          }}
                        />
                        {r.name}
                      </label>
                    )
                  })}
                </div>
              </FormField>
            </FormSection>

            {serverError && (
              <p className="text-sm text-destructive" data-testid="form-error">
                {serverError}
              </p>
            )}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending} data-testid="f-submit">
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              {isEdit ? t("保存修改") : t("创建用户")}
            </Button>
            <SheetClose render={<Button variant="outline" type="button" />}>
              {t("取消")}
            </SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
