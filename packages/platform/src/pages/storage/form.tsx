import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@admin/ui/components/button'
import { Input } from '@admin/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@admin/ui/components/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@admin/ui/components/sheet'
import { Textarea } from '@admin/ui/components/textarea'

import { ApiError } from '../../api-client/errors'
import { useFieldError } from '../_shared/form-error'
import { FormField } from '../_shared/form-fields'
import {
  ADDRESSING_LABELS,
  STORAGE_TYPE_LABELS,
  useCreateStorage,
  useUpdateStorage,
  type Storage,
  type StorageAddressing,
  type StorageType,
} from './api'

// 编码规则和后端 `CustomCode` 一致（那份是权威，这里只为当场报错）
const schema = z.object({
  name: z.string().min(1, '请输入名称').max(64, '名称不能超过 64 个字符'),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, '编码只能是大写字母、数字和下划线，且以字母开头')
    .min(2, '编码至少 2 位')
    .max(32, '编码不能超过 32 位'),
  type: z.enum(['local', 's3']),
  root: z.string().max(512),
  endpoint: z.string().max(255),
  bucket: z.string().max(128),
  region: z.string().max(64),
  addressing: z.enum(['auto', 'virtual', 'path']),
  access_key: z.string().max(128),
  secret_key: z.string(),
  public_base_url: z.string().max(512),
  remark: z.string(),
})
type Values = z.infer<typeof schema>

const EMPTY: Values = {
  name: '',
  code: '',
  type: 's3',
  root: '',
  endpoint: '',
  bucket: '',
  region: '',
  addressing: 'auto',
  access_key: '',
  secret_key: '',
  public_base_url: '',
  remark: '',
}

export function StorageFormSheet({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: Storage | null
}) {
  const { t } = useTranslation()
  const fe = useFieldError()
  const isEdit = editing !== null
  const create = useCreateStorage()
  const update = useUpdateStorage()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<Values>({ resolver: zodResolver(schema) as never, defaultValues: EMPTY })

  React.useEffect(() => {
    if (!open) return
    setServerError(null)
    form.reset(
      editing
        ? {
            name: editing.name,
            code: editing.code,
            type: editing.type,
            root: editing.root ?? '',
            endpoint: editing.endpoint ?? '',
            bucket: editing.bucket ?? '',
            region: editing.region ?? '',
            addressing: editing.addressing,
            access_key: editing.access_key ?? '',
            // 🔴 编辑时永远是空的：接口不下发密钥（连密文都不发）
            secret_key: '',
            public_base_url: editing.public_base_url ?? '',
            remark: editing.remark ?? '',
          }
        : EMPTY,
    )
  }, [open, editing, form])

  const pending = create.isPending || update.isPending
  const type = form.watch('type')

  async function onSubmit(v: Values) {
    setServerError(null)
    if (v.type === 's3' && !isEdit && !v.secret_key.trim()) {
      form.setError('secret_key', { message: '新建对象存储时必须填写 Secret Key' })
      return
    }
    const body = {
      name: v.name.trim(),
      root: v.root.trim(),
      endpoint: v.endpoint.trim() || null,
      bucket: v.bucket.trim() || null,
      region: v.region.trim() || null,
      addressing: v.addressing,
      access_key: v.access_key.trim() || null,
      // 留空 = 不改，传 undefined 而不是空串（同 AI 供应商）
      secret_key: v.secret_key.trim() || undefined,
      public_base_url: v.public_base_url.trim() || null,
      remark: v.remark.trim() || null,
    }
    try {
      if (isEdit && editing) await update.mutateAsync({ id: editing.id, body })
      else await create.mutateAsync({ ...body, code: v.code, type: v.type })
      onOpenChange(false)
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : t('保存失败，请稍后重试'))
    }
  }

  const errs = form.formState.errors
  // 常量表在渲染处翻（同 dept/form.tsx 的 statusItems）
  const typeItems = React.useMemo(
    () => Object.fromEntries(Object.entries(STORAGE_TYPE_LABELS).map(([v, l]) => [v, t(l)])),
    [t],
  )
  const addressingItems = React.useMemo(
    () => Object.fromEntries(Object.entries(ADDRESSING_LABELS).map(([v, l]) => [v, t(l)])),
    [t],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? t('编辑存储') : t('新增存储')}</SheetTitle>
          <SheetDescription>
            {t('对象存储走 S3 协议：AWS S3、MinIO、阿里 OSS、腾讯 COS、七牛等都可以。密钥加密落库，界面上只显示前几位。')}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
            <FormField label={t('名称')} error={fe(errs.name?.message)} required>
              <Input {...form.register('name')} autoComplete="off" maxLength={64} />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                label={t('编码')}
                error={fe(errs.code?.message)}
                required
                hint={isEdit ? t('建后不可修改') : undefined}
              >
                <Input {...form.register('code')} autoComplete="off" maxLength={32} disabled={isEdit} placeholder="OSS_MAIN" />
              </FormField>
              <FormField label={t('类型')} error={fe(errs.type?.message)} required hint={isEdit ? t('建后不可修改') : undefined}>
                <Select
                  value={type}
                  items={typeItems}
                  disabled={isEdit}
                  onValueChange={(v) => form.setValue('type', v as StorageType, { shouldDirty: true })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(typeItems).map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            {type === 'local' ? (
              <FormField
                label={t('根目录')}
                error={fe(errs.root?.message)}
                required
                hint={t('服务器上的绝对路径，如挂载的 NAS 目录。多副本部署时每台机器都要挂同一个目录')}
              >
                <Input {...form.register('root')} autoComplete="off" placeholder="/mnt/nas/uploads" />
              </FormField>
            ) : (
              <>
                {isEdit ? (
                  <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                    {t('改端点、桶或前缀不会搬动已有文件 —— 改完之后，这个存储里的老文件会读不到。')}
                  </p>
                ) : null}
                <FormField
                  label={t('端点')}
                  error={fe(errs.endpoint?.message)}
                  required
                  hint={t('不带桶名，如 https://oss-cn-hangzhou.aliyuncs.com、https://cos.ap-guangzhou.myqcloud.com、http://minio:9000')}
                >
                  <Input {...form.register('endpoint')} autoComplete="off" placeholder="https://oss-cn-hangzhou.aliyuncs.com" />
                </FormField>
                <div className="grid grid-cols-2 gap-4">
                  <FormField label={t('桶名')} error={fe(errs.bucket?.message)} required>
                    <Input {...form.register('bucket')} autoComplete="off" />
                  </FormField>
                  <FormField
                    label={t('区域')}
                    error={fe(errs.region?.message)}
                    hint={t('阿里 OSS 填 cn-hangzhou（不带 oss- 前缀）；MinIO 可留空')}
                  >
                    <Input {...form.register('region')} autoComplete="off" placeholder="cn-hangzhou" />
                  </FormField>
                </div>
                <FormField
                  label={t('寻址方式')}
                  hint={t('阿里 OSS、腾讯 COS 只认虚拟主机风格；MinIO 一般用路径风格。选「自动」按端点域名判断')}
                >
                  <Select
                    value={form.watch('addressing')}
                    items={addressingItems}
                    onValueChange={(v) => form.setValue('addressing', v as StorageAddressing, { shouldDirty: true })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(addressingItems).map(([v, label]) => (
                        <SelectItem key={v} value={v}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label={t('对象键前缀')} error={fe(errs.root?.message)} hint={t('可空。多个系统共用一个桶时用它隔开')}>
                  <Input {...form.register('root')} autoComplete="off" placeholder="fastapi-admin" />
                </FormField>
                <FormField label="Access Key" error={fe(errs.access_key?.message)} required>
                  <Input {...form.register('access_key')} autoComplete="off" />
                </FormField>
                <FormField
                  label="Secret Key"
                  error={fe(errs.secret_key?.message)}
                  required={!isEdit}
                  hint={isEdit ? t('留空表示不修改（接口不会回显已保存的密钥）') : undefined}
                >
                  <Input {...form.register('secret_key')} type="password" autoComplete="new-password" />
                </FormField>
                <FormField
                  label={t('公开访问地址')}
                  error={fe(errs.public_base_url?.message)}
                  hint={t('可空。富文本图片、头像这类公开文件的 CDN / 公开桶域名，对应 <前缀>/public/ 这一层；留空则经后端签发临时地址')}
                >
                  <Input {...form.register('public_base_url')} autoComplete="off" placeholder="https://cdn.example.com" />
                </FormField>
              </>
            )}

            <FormField label={t('备注')}>
              <Textarea {...form.register('remark')} rows={2} />
            </FormField>

            {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          </div>

          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {t('保存')}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>{t('取消')}</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
