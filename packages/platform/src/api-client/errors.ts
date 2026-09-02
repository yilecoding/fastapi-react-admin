/**
 * 错误契约已经搬到 `@admin/api` —— 它是**两端共用**的那一份
 * （`apps/mobile` 不在 `platform` 这条链上，见那个包的 index 注释）。
 *
 * 这里保留一层 re-export：`ApiError` 有十几处调用点（`pages/**`、
 * `ui/components/query-error.tsx`…），没必要为一次搬家全改一遍 import。
 * **新代码直接从 `@admin/api` 取。**
 */
export { ApiError, isEnvelope, type Envelope } from '@admin/api'
