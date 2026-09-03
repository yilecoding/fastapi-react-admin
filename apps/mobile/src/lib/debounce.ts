import * as React from 'react'

/**
 * 把一个高频变化的值延后一拍。搜索框用它 —— 每敲一个字符就发一次请求的话，
 * 「张」「张三」两次里前一次一定是白发的。
 *
 * 🔴 **要延后的是「值」，不是「请求」。** 常见的写法是在 `onChangeText` 里
 * `setTimeout` 一个请求出去（自己管 timer + 取消），那等于把竞态搬到了自己
 * 手里：后发的请求不保证后到，而**后到的会赢**。
 * 延后值之后，它进的是 TanStack Query 的 key（`lib/users.ts` 的
 * `usersKey.list(filter)`）—— 每套条件一份缓存，没有互相覆盖这回事，
 * 而且退回上一个关键词是**秒开**的（缓存还在）。
 *
 * ⚠️ 输入框里显示的仍然是**未延后**的那个值（`useState` 那一份），
 * 否则每敲一个字都要等 300ms 才看到字符 —— 那是「键盘卡了」的感觉。
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value)

  React.useEffect(() => {
    const tm = setTimeout(() => setDebounced(value), delay)
    // 🔴 清掉上一个 timer，否则连续输入时每个字符都会各自到点，
    // 等于完全没有防抖（只是把每次请求都推迟了 300ms）
    return () => clearTimeout(tm)
  }, [value, delay])

  return debounced
}
