/** FBA 的分页返回结构，直接喂 TanStack Table 的服务端分页 */
export type PageData<T> = {
  items: T[]
  total: number
  page: number
  size: number
  total_pages: number
  links: { first: string; last: string; next: string | null; prev: string | null }
}
