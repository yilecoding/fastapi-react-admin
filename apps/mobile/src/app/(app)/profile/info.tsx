import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView, View } from 'react-native'

import { Group, GroupHeader, Row } from '@/components/grouped'
import { Text } from '@/components/ui/text'
import { useSession } from '@/lib/session'

/**
 * 个人资料：只读。「我的」首屏只放入口，资料收在这一屏里。
 *
 * ⚠️ **刻意不显示账号 ID。** 它是雪花 ID，对用户没有任何用处，原来摆在「我的」首屏上只是占地方。
 * 管理员看别人时（`users/[id].tsx`）才需要它。
 *
 * 能改的东西不在这一屏：昵称 / 头像在「编辑资料」，手机号在 `profile/phone.tsx`。
 * 邮箱只读 —— `PUT /me/email` 要邮件验证码，那条链路移动端还没有。
 */
export default function ProfileInfoScreen() {
  const { t } = useTranslation()
  const { user } = useSession()
  if (!user) return null

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="pb-10">
      <GroupHeader>{t('账号')}</GroupHeader>
      <Group>
        <Field first label={t('用户名')} value={user.username} mono />
        <Field label={t('昵称')} value={user.nickname} />
        <Field label={t('账号类型')} value={t(accountKind(user))} />
      </Group>

      <GroupHeader>{t('组织')}</GroupHeader>
      <Group>
        <Field first label={t('部门')} value={user.dept} />
        <Field label={t('角色')} value={user.roles.join('、')} />
      </Group>

      <GroupHeader>{t('联系方式')}</GroupHeader>
      <Group>
        <Field first label={t('邮箱')} value={user.email} note={t('改邮箱要邮件验证码')} />
        <Field label={t('时区')} value={user.timezone} mono />
      </Group>
    </ScrollView>
  )
}

/** ⚠️ 返回 **key**，由调用处 `t()` */
function accountKind(user: { is_superuser: boolean; is_staff: boolean }) {
  return user.is_superuser ? '超级管理员' : user.is_staff ? '后台管理员' : '普通用户'
}

function Field({
  first,
  label,
  value,
  note,
  mono,
}: {
  first?: boolean
  label: string
  value?: string | null
  note?: string
  mono?: boolean
}) {
  return (
    <Row first={first} className="items-start">
      <Text className="shrink-0 text-[15px]">{label}</Text>
      <View className="flex-1 items-end">
        <Text
          className={`text-muted-foreground text-right ${mono ? 'font-mono text-xs' : 'text-[14px]'}`}
          numberOfLines={2}
        >
          {value?.trim() ? value : '—'}
        </Text>
        {note ? <Text className="text-muted-foreground/70 mt-0.5 text-right text-[11px]">{note}</Text> : null}
      </View>
    </Row>
  )
}
