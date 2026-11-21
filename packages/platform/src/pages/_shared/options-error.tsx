import { useTranslation } from 'react-i18next'

import { ApiError } from '../../api-client/errors'

/**
 * 表单里「选项取不到」的那一行：挂在下拉 / 复选组正下方，一行字 + 重试。
 *
 * 🔴 存在的理由是硬纪律 9。表单里的选项查询（角色、部门、模型、字段……）原来都写成
 * `const { data: roles = [] } = useQuery(...)`：接口挂了，下拉就是空的，看起来像
 * 「系统里没有角色」，提交又被「至少选择一个角色」挡住 —— 用户看不出原因（#397）。
 *
 * 整块的 `QueryError` 放进表单字段里太重，这里只占一行。403 不给重试：
 * 再点一次还是 403，提示「没有权限」就够了。
 */
export function OptionsError({
  error,
  onRetry,
  testId = 'options-error',
}: {
  error: unknown
  onRetry: () => void
  testId?: string
}) {
  const { t } = useTranslation()
  const forbidden = error instanceof ApiError && error.httpStatus === 403
  return (
    <span className="text-xs text-destructive" role="alert" data-testid={testId}>
      {forbidden ? t('没有权限查看这些数据') : t('加载失败')}
      {!forbidden && (
        <button
          type="button"
          onClick={onRetry}
          className="ms-1 underline underline-offset-2"
          data-testid={`${testId}-retry`}
        >
          {t('重试')}
        </button>
      )}
    </span>
  )
}
